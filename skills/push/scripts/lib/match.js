'use strict';

/**
 * A small glob matcher, so this skill has no dependencies.
 *
 * Supports the four things a path map actually needs:
 *   **\/  zero or more directories      src/**\/*.ts
 *   *     anything except a slash       *.json
 *   ?     one character except a slash
 *   {a,b} alternation                   **\/*.{ts,tsx}
 */

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

const escapeLiteral = (text) => text.replace(REGEX_SPECIALS, '\\$&');

/** Compile one glob to an anchored RegExp. */
function globToRegExp(glob) {
  let source = '';

  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];

    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match zero directories, so `src/**/x` matches `src/x`.
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    if (char === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        source += '\\{';
        continue;
      }
      const options = glob.slice(i + 1, close).split(',').map(escapeLiteral);
      source += `(?:${options.join('|')})`;
      i = close;
      continue;
    }

    source += escapeLiteral(char);
  }

  return new RegExp(`^${source}$`);
}

const cache = new Map();

const compile = (glob) => {
  if (!cache.has(glob)) cache.set(glob, globToRegExp(glob));
  return cache.get(glob);
};

/** Does `filePath` match this glob? */
const matches = (filePath, glob) => compile(glob).test(filePath);

/** Does `filePath` match any glob in the list? */
const matchesAny = (filePath, globs = []) => globs.some((glob) => matches(filePath, glob));

module.exports = { globToRegExp, matches, matchesAny };
