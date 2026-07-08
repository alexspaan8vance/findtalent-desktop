import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { defaultLocale, isLocale, type Locale } from './config';
import { getMessagesForLocale } from './get-messages';

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieValue = store.get('NEXT_LOCALE')?.value;
  const locale: Locale = isLocale(cookieValue) ? cookieValue : defaultLocale;

  return {
    locale,
    messages: getMessagesForLocale(locale),
  };
});
