export const allowEmptyInt = (v) => {
  if (v === '' || v === null || v === undefined) return '';
  const s = String(v).replace(/[^\d]/g, '');
  return s === '' ? '' : String(parseInt(s, 10));
};
export const allowEmptyFloat = (v) => {
  if (v === '' || v === null || v === undefined) return '';
  const s = String(v).replace(/[^0-9.]/g,'').replace(/(\..*)\./g,'$1');
  return s;
};
export const clampInt = (v, min, max) => {
  if (v === '' || v === null || v === undefined) return '';
  let n = parseInt(v, 10);
  if (isNaN(n)) n = (min ?? 0);
  if (min != null && n < min) n = min;
  if (max != null && n > max) n = max;
  return String(n);
};
export const clampFloat = (v, min, max) => {
  if (v === '' || v === null || v === undefined) return '';
  let n = parseFloat(v);
  if (isNaN(n)) n = (min ?? 0);
  if (min != null && n < min) n = min;
  if (max != null && n > max) n = max;
  return String(n);
};
