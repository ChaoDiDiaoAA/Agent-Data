export function errorField(error: unknown, key: string): unknown {
  return error && typeof error === 'object' && key in error ? Reflect.get(error, key) : undefined;
}

function consumeStructuredValue(text: string, start: number) {
  if (text[start] === '\\' && ['"', "'"].includes(text[start + 1])) {
    const outerQuote = text[start + 1];
    const closing: Record<string, string> = { '{': '}', '[': ']' };
    const stack: string[] = [];
    let backslashes = 0;
    let quote: string | null = null;
    for (let index = start + 2; index < text.length; index += 1) {
      const character = text[index];
      if (character === '\\') { backslashes += 1; continue; }
      if ((character === '"' || character === "'") && backslashes % 2 === 1) {
        const structuralQuote = backslashes % 4 === 1;
        if (structuralQuote && character === outerQuote && quote === null && stack.length === 0) return index + 1;
        if (!structuralQuote && quote === character) { backslashes = 0; continue; }
        if (quote === character) quote = null;
        else if (!quote && structuralQuote) quote = character;
        backslashes = 0;
        continue;
      }
      backslashes = 0;
      if (quote) continue;
      if (closing[character]) stack.push(character);
      else if (Object.values(closing).includes(character)) {
        if (closing[stack.at(-1)!] === character) stack.pop();
      }
    }
    return text.length;
  }
  const opening = text[start];
  if (!['{', '['].includes(opening)) {
    if (opening === '"' || opening === "'") {
      let escaped = false;
      for (let index = start + 1; index < text.length; index += 1) {
        const character = text[index];
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === opening) return index + 1;
      }
      return text.length;
    }
    const boundary = text.slice(start).search(/[\s,;]/);
    return boundary < 0 ? text.length : start + boundary;
  }
  const closing: Record<string, string> = { '{': '}', '[': ']' };
  const stack = [opening];
  let quote: string | null = null;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (closing[character]) stack.push(character);
    else if (Object.values(closing).includes(character)) {
      if (closing[stack.at(-1)!] !== character) return index + 1;
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return text.length;
}

function redactConfigValues(text: string) {
  const assignment = /(?<![A-Za-z0-9_$])(["']?(?:config(?:uration)?[\w.-]*|[A-Za-z_][\w.-]*[_\-.]config(?:uration)?[\w.-]*)["']?)\s*([=:])\s*/gi;
  let result = '';
  let cursor = 0;
  let match;
  while ((match = assignment.exec(text))) {
    const valueStart = assignment.lastIndex;
    const valueEnd = consumeStructuredValue(text, valueStart);
    result += text.slice(cursor, valueStart);
    result += '[redacted]';
    cursor = valueEnd;
    assignment.lastIndex = valueEnd;
  }
  return `${result}${text.slice(cursor)}`;
}

export function redactErrorMessage(error: unknown) {
  const message = errorField(error, 'errorMessage') ?? errorField(error, 'message') ?? error;
  return redactConfigValues(String(message))
    .replace(
      /((?:-{1,2}|\/)(?:encodedcommand|enc)\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
      '$1[redacted]',
    )
    .replace(/https?:\/\/\S+/g, '[redacted-url]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /((?:\\?["']?)(?:authorization|www-authenticate)(?:\\?["']?)\s*[=:]\s*)(?:(?:\\?["'])(?:\\.|[^"'\\])*(?:\\?["'])|\S+)/gi,
      '$1[redacted]',
    )
    .replace(
      /((?:\\?["']?)(?:[A-Za-z_][\w.-]*?)?(?:token|secret(?:[-_]?key)?|password|passwd|api[-_]?key|credential|auth|proxy(?:[-_](?:user|username|password|token|key))?|[-_]json)(?:\\?["']?)\s*[=:]\s*)(?:(?:\\?["'])(?:\\.|[^"'\\])*(?:\\?["'])|\{(?:\\.|[^}\\])*\}|\S+)/gi,
      '$1[redacted]',
    );
}
