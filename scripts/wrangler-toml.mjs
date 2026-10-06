export function wranglerToml(config) {
  const lines = [];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const tables = value => object(value) || (Array.isArray(value) && value.length > 0 && value.every(object));
  const key = value => /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
  const scalar = value => {
    if (Array.isArray(value)) return `[${value.map(scalar).join(', ')}]`;
    if (['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    throw new Error('unsupported_toml_value');
  };
  const emit = (value, prefix = '') => {
    for (const [name, item] of Object.entries(value)) {
      if (!tables(item)) lines.push(`${key(name)} = ${scalar(item)}`);
    }
    for (const [name, item] of Object.entries(value)) {
      if (!tables(item)) continue;
      const path = prefix ? `${prefix}.${key(name)}` : key(name);
      if (Array.isArray(item)) {
        for (const entry of item) { lines.push('', `[[${path}]]`); emit(entry, path); }
      } else {
        lines.push('', `[${path}]`);
        emit(item, path);
      }
    }
  };
  emit(config);
  return lines.join('\n') + '\n';
}
