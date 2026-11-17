// Minimal glob → RegExp for tool filters: `**` any depth, `*` within a segment, `?` one char.
// A pattern without a slash matches the file name anywhere (like `*.py`).

export function globToRegExp(glob: string): RegExp {
  const pattern = glob.includes('/') ? glob : `**/${glob}`;
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${out}$`, 'i');
}
