import React from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DesktopAgentRunner } from '../../app/components/desktop-agent-runner';

const desktop = {
  bridge: window.avalDesktop,
  setModel: model => window.avalDesktop.setModel(model),
  setActive: active => window.avalDesktop.setActive(active),
};
createRoot(document.getElementById('root')).render(
  <NextIntlClientProvider locale="en" messages={{}}>
    <DesktopAgentRunner desktop={desktop} />
  </NextIntlClientProvider>,
);
