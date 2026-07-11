module.exports = {
  root: true,
  parser: '@typescript-eslint/parser', // Specifies the ESLint parser
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended', // Uses the recommended rules from the @typescript-eslint/eslint-plugin
    'plugin:jsx-a11y/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:react/jsx-runtime',
    'prettier',
  ],
  parserOptions: {
    ecmaVersion: 6,
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  rules: {
    '@typescript-eslint/camelcase': 0,
    '@typescript-eslint/no-use-before-define': 0,
    'jsx-a11y/no-noninteractive-tabindex': 0,
    'arrow-parens': 'off',
    'jsx-a11y/anchor-is-valid': 'off',
    'no-console': 1,
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    'formatjs/no-offset': 'error',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error'],
    '@typescript-eslint/array-type': ['error', { default: 'array' }],
    'jsx-a11y/no-onchange': 'off',
    '@typescript-eslint/consistent-type-imports': [
      'error',
      {
        prefer: 'type-imports',
      },
    ],
    'no-relative-import-paths/no-relative-import-paths': [
      'error',
      { allowSameFolder: true },
    ],
  },
  overrides: [
    {
      files: ['**/*.tsx'],
      rules: {
        'react/prop-types': 'off',
      },
    },
    {
      // The app replaces the global Intl object with the andyearnshaw `intl` SSR
      // polyfill (src/pages/_app.tsx). Server code shares that global at runtime,
      // where Intl.DateTimeFormat throws "timeZone is not supported" for named
      // timezones and Intl.DisplayNames/ListFormat/PluralRules/Collator/
      // RelativeTimeFormat are undefined. Native-Node tests pass while prod
      // throws (fork#35). Ban these in server code; use Date.prototype
      // .toLocaleString via server/utils/dateHelpers instead, or guard
      // construction in a try/catch (see OverlayContextBuilder DisplayNames).
      //
      // Both construction forms are covered: `new Intl.X()` (NewExpression) and
      // the call-as-function form `Intl.DateTimeFormat(...)` (CallExpression),
      // which is legal ECMA-402 and hits the SAME polyfill throw. NOT covered
      // (inherent to AST selectors, and won't be typed by accident): aliasing
      // (`const D = Intl.DateTimeFormat; new D()`) and bracket access
      // (`Intl['DateTimeFormat']`). This lint is the only pre-prod guard for
      // this class, since native-Node tests pass while prod throws.
      files: ['server/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "NewExpression[callee.object.name='Intl'][callee.property.name='DateTimeFormat'], CallExpression[callee.object.name='Intl'][callee.property.name='DateTimeFormat']",
            message:
              'Intl.DateTimeFormat is replaced by the SSR `intl` polyfill and throws "timeZone is not supported" for named timezones in production. Use Date.prototype.toLocaleString via server/utils/dateHelpers (toServerCalendarDate / getCalendarDateInTimezone).',
          },
          {
            selector:
              "NewExpression[callee.object.name='Intl'][callee.property.name=/^(DisplayNames|ListFormat|PluralRules|Collator|RelativeTimeFormat)$/], CallExpression[callee.object.name='Intl'][callee.property.name=/^(DisplayNames|ListFormat|PluralRules|Collator|RelativeTimeFormat)$/]",
            message:
              'This Intl constructor is not provided by the SSR `intl` polyfill (src/pages/_app.tsx) and throws "not a constructor"/"timeZone is not supported" server-side after the first SSR render. Guard construction in a try/catch, or avoid it.',
          },
        ],
      },
    },
  ],
  plugins: ['jsx-a11y', 'react-hooks', 'formatjs', 'no-relative-import-paths'],
  settings: {
    react: {
      pragma: 'React',
      version: '16.8',
    },
  },
  env: {
    browser: true,
    node: true,
    jest: true,
    es6: true,
  },
  reportUnusedDisableDirectives: true,
};
