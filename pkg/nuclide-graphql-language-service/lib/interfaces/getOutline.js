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

import type {Outline, TextToken, TokenKind} from '../types/Types';

import {parse, visit} from 'graphql';
import {INLINE_FRAGMENT} from 'graphql/language/kinds';

import {offsetToPoint} from '../utils/Range';

const OUTLINEABLE_KINDS = {
  Field: true,
  OperationDefinition: true,
  Document: true,
  SelectionSet: true,
  Name: true,
  FragmentDefinition: true,
  FragmentSpread: true,
  InlineFragment: true,
};

type OutlineTreeConverterType = {[name: string]: Function};

export function getOutline(queryText: string): ?Outline {
  let ast;
  try {
    ast = parse(queryText);
  } catch (error) {
    return null;
  }

  const visitorFns = outlineTreeConverter(queryText);
  const outlineTrees = visit(ast, {
    leave(node) {
      if (OUTLINEABLE_KINDS[node.kind] && visitorFns[node.kind]) {
        return visitorFns[node.kind](node);
      }
      return null;
    },
  });
  return {outlineTrees};
}

function outlineTreeConverter(docText: string): OutlineTreeConverterType {
  const meta = node => ({
    representativeName: node.name,
    startPosition: offsetToPoint(docText, node.loc.start),
    endPosition: offsetToPoint(docText, node.loc.end),
    children: node.selectionSet || [],
  });
  return {
    Field: node => {
      const tokenizedText = node.alias
        ? [buildToken('plain', node.alias), buildToken('plain', ': ')]
        : [];
      tokenizedText.push(buildToken('plain', node.name));
      return {tokenizedText, ...meta(node)};
    },
    OperationDefinition: node => {
      const nodeName = node.name || 'AnonymousQuery';
      const metaObject = meta(node);
      if (metaObject.representativeName === null) {
        metaObject.representativeName = nodeName;
      }
      return {
        tokenizedText: [
          buildToken('keyword', node.operation),
          buildToken('whitespace', ' '),
          buildToken('class-name', nodeName),
        ],
        ...metaObject,
      };
    },
    Document: node => node.definitions,
    SelectionSet: node =>
      concatMap(
        node.selections,
        child => (child.kind === INLINE_FRAGMENT ? child.selectionSet : child),
      ),
    Name: node => node.value,
    FragmentDefinition: node => ({
      tokenizedText: [
        buildToken('keyword', 'fragment'),
        buildToken('whitespace', ' '),
        buildToken('class-name', node.name),
      ],
      ...meta(node),
    }),
    FragmentSpread: node => ({
      tokenizedText: [
        buildToken('plain', '...'),
        buildToken('class-name', node.name),
      ],
      ...meta(node),
    }),
    InlineFragment: node => node.selectionSet,
  };
}

function buildToken(kind: TokenKind, value: string): TextToken {
  return {kind, value};
}

function concatMap(arr: Array<any>, fn: Function): Array<any> {
  const res = [];
  for (let i = 0; i < arr.length; i++) {
    const x = fn(arr[i], i);
    if (Array.isArray(x)) {
      res.push(...x);
    } else {
      res.push(x);
    }
  }
  return res;
}
