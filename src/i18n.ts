// English source catalog barrel. Components must keep reading visible copy from
// "../i18n" or "./i18n" so a future locale can replace one typed module.
// Namespace content lives in src/i18n/*.ts with zero text changes.
import { app, appName, common, window } from "./i18n/common";
import { composer } from "./i18n/composer";
import { contextMenu } from "./i18n/contextMenu";
import { errors } from "./i18n/errors";
import { mail } from "./i18n/mail";
import { reader } from "./i18n/reader";
import { settings } from "./i18n/settings";
import { setup } from "./i18n/setup";
import { update } from "./i18n/update";

export const strings = {
  appName,
  common,
  window,
  app,
  mail,
  reader,
  update,
  composer,
  setup,
  settings,
  errors,
  contextMenu,
} as const;
