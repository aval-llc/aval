import React from 'react';
import {createRoot} from 'react-dom/client';
import {NextIntlClientProvider} from 'next-intl';
import {PmsDesktopSession} from '../../app/components/pms-desktop-session';
import messages from '../../messages/en.json';

createRoot(document.getElementById('root')).render(
  <NextIntlClientProvider locale="en" messages={messages}>
    <main>
      <small>AVAL · LOCAL SUPERVISED PILOT</small>
      <h1>Connect your restricted Buildium staff account</h1>
      <p>This is an isolated local test workspace, not your hosted portfolio.</p>
      <p>Use the button below to open Buildium. Enter your password only in Buildium’s window. Return here to check the connection after signing in.</p>
      <PmsDesktopSession provider="buildium"/>
      <p>Write execution and model inference are disabled in this setup screen. A separate exact approval is required before a work order can be created.</p>
    </main>
  </NextIntlClientProvider>,
);
