import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormattedRelativeTime, IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { nextRunRelativeTimeProps } from './relativeTimeProps';

describe('nextRunRelativeTimeProps', () => {
  it('returns day unit with no updateIntervalInSeconds beyond 48h', () => {
    const props = nextRunRelativeTimeProps(40 * 86400);
    expect(props.unit).toBe('day');
    expect(props.updateIntervalInSeconds).toBeUndefined();
  });

  it('does not throw react-intl\'s "unit longer than hour" invariant when rendered', () => {
    const props = nextRunRelativeTimeProps(40 * 86400);
    expect(() =>
      renderToStaticMarkup(
        createElement(
          IntlProvider,
          { locale: 'en' },
          createElement(FormattedRelativeTime, { ...props, numeric: 'auto' })
        )
      )
    ).not.toThrow();
  });
});
