// Interpolated raw into SVG attributes — grammar doubles as the injection guard.
// No flags: `.source` is embedded verbatim as the `pattern:` value for
// PUT /source-colors/{sourceType} in agregarr-api.yml (see colorValue.test.ts).
// Byte components are range-bound in the regex itself (0-255); `\s` is
// deliberately avoided — form feed/vertical tab are invalid inside an XML
// attribute and would otherwise pass here and break SVG rendering downstream.
export const COLOR_VALUE_PATTERN =
  /^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgb\( *(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9]) *, *(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9]) *, *(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9]) *\)|rgba\( *(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9]) *, *(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9]) *, *(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9]) *, *(0|1|0?\.\d+|1\.0) *\))$/;
