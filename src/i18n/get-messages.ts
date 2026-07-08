import type { Locale } from './config';

import enMessages from '../../messages/en.json';
import nlMessages from '../../messages/nl.json';
import deMessages from '../../messages/de.json';

export type Messages = typeof enMessages;

const REGISTRY: Readonly<Record<Locale, Messages>> = {
  en: enMessages,
  nl: nlMessages as Messages,
  de: deMessages as Messages,
};

export function getMessagesForLocale(locale: Locale): Messages {
  return REGISTRY[locale];
}
