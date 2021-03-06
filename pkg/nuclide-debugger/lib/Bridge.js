/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type DebuggerModel from './DebuggerModel';
import type {
  Callstack,
  EvalCommand,
  ScopeSection,
  NuclideThreadData,
  ThreadItem,
  BreakpointUserChangeArgType,
  IPCBreakpoint,
  ExpressionResult,
  GetPropertiesResult,
} from './types';

import nuclideUri from 'nuclide-commons/nuclideUri';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {DebuggerMode} from './DebuggerStore';
import invariant from 'assert';
import {Observable} from 'rxjs';
import CommandDispatcher from './CommandDispatcher';

export default class Bridge {
  _debuggerModel: DebuggerModel;
  _disposables: UniversalDisposable;
  // Contains disposable items should be disposed by
  // cleanup() method.
  _cleanupDisposables: ?UniversalDisposable;
  _webview: ?WebviewElement;
  _webviewUrl: ?string;
  _commandDispatcher: CommandDispatcher;
  _suppressBreakpointSync: boolean;

  constructor(debuggerModel: DebuggerModel) {
    (this: any)._handleIpcMessage = this._handleIpcMessage.bind(this);
    this._debuggerModel = debuggerModel;
    this._suppressBreakpointSync = false;
    this._commandDispatcher = new CommandDispatcher();
    this._disposables = new UniversalDisposable(
      debuggerModel
        .getBreakpointStore()
        .onUserChange(this._handleUserBreakpointChange.bind(this)),
    );
  }

  dispose() {
    this.cleanup();
    this._disposables.dispose();
  }

  // Clean up any state changed after constructor.
  cleanup() {
    if (this._cleanupDisposables != null) {
      this._cleanupDisposables.dispose();
      this._cleanupDisposables = null;
    }
  }

  continue() {
    this._commandDispatcher.send('Continue');
  }

  stepOver() {
    this._commandDispatcher.send('StepOver');
  }

  stepInto() {
    this._commandDispatcher.send('StepInto');
  }

  stepOut() {
    this._commandDispatcher.send('StepOut');
  }

  runToLocation(filePath: string, line: number) {
    this._commandDispatcher.send('RunToLocation', filePath, line);
  }

  triggerAction(actionId: string): void {
    this._commandDispatcher.send('triggerDebuggerAction', actionId);
  }

  setSelectedCallFrameIndex(callFrameIndex: number): void {
    this._commandDispatcher.send('setSelectedCallFrameIndex', callFrameIndex);
  }

  setPauseOnException(pauseOnExceptionEnabled: boolean): void {
    this._commandDispatcher.send(
      'setPauseOnException',
      pauseOnExceptionEnabled,
    );
  }

  setPauseOnCaughtException(pauseOnCaughtExceptionEnabled: boolean): void {
    this._commandDispatcher.send(
      'setPauseOnCaughtException',
      pauseOnCaughtExceptionEnabled,
    );
  }

  setSingleThreadStepping(singleThreadStepping: boolean): void {
    this._commandDispatcher.send(
      'setSingleThreadStepping',
      singleThreadStepping,
    );
  }

  selectThread(threadId: string): void {
    this._commandDispatcher.send('selectThread', threadId);
    const threadNo = parseInt(threadId, 10);
    if (!isNaN(threadNo)) {
      this._debuggerModel.getActions().updateSelectedThread(threadNo);
    }
  }

  sendEvaluationCommand(
    command: EvalCommand,
    evalId: number,
    ...args: Array<mixed>
  ): void {
    this._commandDispatcher.send(command, evalId, ...args);
  }

  _handleExpressionEvaluationResponse(
    response: ExpressionResult & {id: number},
  ): void {
    this._debuggerModel
      .getActions()
      .receiveExpressionEvaluationResponse(response.id, response);
  }

  _handleGetPropertiesResponse(
    response: GetPropertiesResult & {id: number},
  ): void {
    this._debuggerModel
      .getActions()
      .receiveGetPropertiesResponse(response.id, response);
  }

  _handleCallstackUpdate(callstack: Callstack): void {
    this._debuggerModel.getActions().updateCallstack(callstack);
  }

  _handleScopesUpdate(scopeSections: Array<ScopeSection>): void {
    this._debuggerModel.getActions().updateScopes(scopeSections);
  }

  _handleIpcMessage(stdEvent: Event): void {
    // addEventListener expects its callback to take an Event. I'm not sure how to reconcile it with
    // the type that is expected here.
    // $FlowFixMe(jeffreytan)
    const event: {channel: string, args: any[]} = stdEvent;
    switch (event.channel) {
      case 'notification':
        switch (event.args[0]) {
          case 'ready':
            if (
              atom.config.get(
                'nuclide.nuclide-debugger.openDevToolsOnDebuggerStart',
              )
            ) {
              this.openDevTools();
            }
            this._updateDebuggerSettings();
            this._sendAllBreakpoints();
            this._syncDebuggerState();
            break;
          case 'CallFrameSelected':
            this._setSelectedCallFrameLine(event.args[1]);
            break;
          case 'OpenSourceLocation':
            this._openSourceLocation(event.args[1]);
            break;
          case 'ClearInterface':
            this._handleClearInterface();
            break;
          case 'DebuggerResumed':
            this._handleDebuggerResumed();
            break;
          case 'LoaderBreakpointResumed':
            this._handleLoaderBreakpointResumed();
            break;
          case 'BreakpointAdded':
            // BreakpointAdded from chrome side is actually
            // binding the breakpoint.
            this._bindBreakpoint(
              event.args[1],
              event.args[1].resolved === true,
            );
            break;
          case 'BreakpointRemoved':
            this._removeBreakpoint(event.args[1]);
            break;
          case 'NonLoaderDebuggerPaused':
            this._handleDebuggerPaused(event.args[1]);
            break;
          case 'ExpressionEvaluationResponse':
            this._handleExpressionEvaluationResponse(event.args[1]);
            break;
          case 'GetPropertiesResponse':
            this._handleGetPropertiesResponse(event.args[1]);
            break;
          case 'CallstackUpdate':
            this._handleCallstackUpdate(event.args[1]);
            break;
          case 'ScopesUpdate':
            this._handleScopesUpdate(event.args[1]);
            break;
          case 'ThreadsUpdate':
            this._handleThreadsUpdate(event.args[1]);
            break;
          case 'ThreadUpdate':
            this._handleThreadUpdate(event.args[1]);
            break;
        }
        break;
    }
  }

  _updateDebuggerSettings(): void {
    this._commandDispatcher.send(
      'UpdateSettings',
      this._debuggerModel.getStore().getSettings().getSerializedData(),
    );
  }

  _syncDebuggerState(): void {
    const store = this._debuggerModel.getStore();
    this.setPauseOnException(store.getTogglePauseOnException());
    this.setPauseOnCaughtException(store.getTogglePauseOnCaughtException());
    this.setSingleThreadStepping(store.getEnableSingleThreadStepping());
  }

  _handleDebuggerPaused(
    options: ?{
      stopThreadId: number,
      threadSwitchNotification: {
        sourceURL: string,
        lineNumber: number,
        message: string,
      },
    },
  ): void {
    this._debuggerModel.getActions().setDebuggerMode(DebuggerMode.PAUSED);
    if (options != null) {
      if (options.stopThreadId != null) {
        this._handleStopThreadUpdate(options.stopThreadId);
      }
      this._handleStopThreadSwitch(options.threadSwitchNotification);
    }
  }

  _handleDebuggerResumed(): void {
    this._debuggerModel.getActions().setDebuggerMode(DebuggerMode.RUNNING);
  }

  _handleLoaderBreakpointResumed(): void {
    this._debuggerModel.getStore().loaderBreakpointResumed();
  }

  _handleClearInterface(): void {
    this._debuggerModel.getActions().clearInterface();
  }

  _setSelectedCallFrameLine(
    options: ?{sourceURL: string, lineNumber: number},
  ): void {
    this._debuggerModel.getActions().setSelectedCallFrameLine(options);
  }

  _openSourceLocation(options: ?{sourceURL: string, lineNumber: number}): void {
    if (options == null) {
      return;
    }
    this._debuggerModel
      .getActions()
      .openSourceLocation(options.sourceURL, options.lineNumber);
  }

  _handleStopThreadSwitch(
    options: ?{sourceURL: string, lineNumber: number, message: string},
  ) {
    if (options == null) {
      return;
    }
    this._debuggerModel
      .getActions()
      .notifyThreadSwitch(
        options.sourceURL,
        options.lineNumber,
        options.message,
      );
  }

  _bindBreakpoint(breakpoint: IPCBreakpoint, resolved: boolean) {
    const {sourceURL, lineNumber, condition, enabled} = breakpoint;
    const path = nuclideUri.uriToNuclideUri(sourceURL);
    // only handle real files for now.
    if (path) {
      try {
        this._suppressBreakpointSync = true;
        this._debuggerModel
          .getActions()
          .bindBreakpointIPC(path, lineNumber, condition, enabled, resolved);
      } finally {
        this._suppressBreakpointSync = false;
      }
    }
  }

  _removeBreakpoint(breakpoint: IPCBreakpoint) {
    const {sourceURL, lineNumber} = breakpoint;
    const path = nuclideUri.uriToNuclideUri(sourceURL);
    // only handle real files for now.
    if (path) {
      try {
        this._suppressBreakpointSync = true;
        this._debuggerModel.getActions().deleteBreakpointIPC(path, lineNumber);
      } finally {
        this._suppressBreakpointSync = false;
      }
    }
  }

  _handleUserBreakpointChange(params: BreakpointUserChangeArgType) {
    const {action, breakpoint} = params;
    this._commandDispatcher.send(action, {
      sourceURL: nuclideUri.nuclideUriToUri(breakpoint.path),
      lineNumber: breakpoint.line,
      condition: breakpoint.condition,
      enabled: breakpoint.enabled,
    });
  }

  _handleThreadsUpdate(threadData: NuclideThreadData): void {
    this._debuggerModel.getActions().updateThreads(threadData);
  }

  _handleThreadUpdate(thread: ThreadItem): void {
    this._debuggerModel.getActions().updateThread(thread);
  }

  _handleStopThreadUpdate(id: number): void {
    this._debuggerModel.getActions().updateStopThread(id);
  }

  _sendAllBreakpoints() {
    // Send an array of file/line objects.
    if (!this._suppressBreakpointSync) {
      const results = [];
      this._debuggerModel
        .getBreakpointStore()
        .getAllBreakpoints()
        .forEach(breakpoint => {
          results.push({
            sourceURL: nuclideUri.nuclideUriToUri(breakpoint.path),
            lineNumber: breakpoint.line,
            condition: breakpoint.condition,
            enabled: breakpoint.enabled,
          });
        });
      this._commandDispatcher.send('SyncBreakpoints', results);
    }
  }

  renderChromeWebview(url: string): void {
    if (this._webview == null) {
      // Cast from HTMLElement down to WebviewElement without instanceof
      // checking, as WebviewElement constructor is not exposed.
      const webview = ((document.createElement(
        'webview',
      ): any): WebviewElement);
      webview.src = url;
      webview.nodeintegration = true;
      webview.disablewebsecurity = true;
      webview.classList.add('native-key-bindings'); // required to pass through certain key events
      webview.classList.add('nuclide-debugger-webview');

      // The webview is actually only used for its state; it's really more of a model that just has
      // to live in the DOM. We render it into the body to keep it separate from our view, which may
      // be detached. If the webview were a child, it would cause the webview to reload when
      // reattached, and we'd lose our state.
      invariant(document.body != null);
      document.body.appendChild(webview);

      this._setWebviewElement(webview);
    } else if (url !== this._webviewUrl) {
      this._webview.src = url;
    }
    this._webviewUrl = url;
  }

  // Exposed for tests
  _setWebviewElement(webview: WebviewElement): void {
    this._webview = webview;
    this._commandDispatcher.setupChromeChannel(webview);
    invariant(this._cleanupDisposables == null);
    this._cleanupDisposables = new UniversalDisposable(
      Observable.fromEvent(webview, 'ipc-message').subscribe(
        this._handleIpcMessage,
      ),
      () => {
        webview.remove();
        this._webview = null;
        this._webviewUrl = null;
      },
    );
  }

  setupNuclideChannel(debuggerInstance: Object): Promise<void> {
    return this._commandDispatcher.setupNuclideChannel(debuggerInstance);
  }

  openDevTools(): void {
    if (this._webview == null) {
      return;
    }
    this._webview.openDevTools();
  }
}
