"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import { Mail, NavArrowLeft, NavArrowRight, NetworkLeft, Search, Xmark } from "iconoir-react";
import { BrandMark } from "./brand-mark";
import type { Provider } from "./connection-dialog";

export type SetupProviderKind = "communication" | "pms";

const COMMUNICATION_ORDER = ["gmail", "outlook", "whatsapp_personal", "slack", "apple_messages"];
const PMS_ORDER = ["appfolio", "buildium", "yardi", "yardi_breeze", "realpage", "entrata", "doorloop", "rentmanager"];

function rank(id: string, order: readonly string[]) {
  const index = order.indexOf(id);
  return index < 0 ? order.length : index;
}

function canConnect(provider: Provider, kind: SetupProviderKind) {
  if (kind === "pms") return provider.id === "appfolio";
  return provider.authMode === "oauth2" || provider.authMode === "qr_link";
}

export function SetupProviderPicker({
  kind,
  providers,
  onClose,
  onChoose,
}: {
  kind: SetupProviderKind;
  providers: Provider[];
  onClose: () => void;
  onChoose: (provider: Provider) => void;
}) {
  const t = useTranslations("SetupGraph");
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const order = kind === "communication" ? COMMUNICATION_ORDER : PMS_ORDER;
  const options = useMemo(() => providers
    .filter((provider) => kind === "communication"
      ? provider.category === "Communication" && COMMUNICATION_ORDER.includes(provider.id)
      : provider.category === "Leasing & PMS")
    .filter((provider) => !query || `${provider.title} ${provider.description}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => rank(a.id, order) - rank(b.id, order) || a.title.localeCompare(b.title)), [kind, order, providers, query]);
  const Icon = kind === "communication" ? Mail : NetworkLeft;

  return <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay setup-picker-overlay"/>
      <Dialog.Content className="setup-provider-picker" onOpenAutoFocus={(event) => { event.preventDefault(); search.current?.focus(); }}>
        <span className="setup-picker-kind"><Icon width={13}/>{kind === "communication" ? "Communication" : "PMS"}</span>
        <div className="setup-picker-search">
          <button type="button" onClick={onClose} aria-label="Back"><NavArrowLeft width={18}/></button>
          <Search width={18}/>
          <input ref={search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t(kind === "communication" ? "searchCommunication" : "searchPms")} aria-label={t("providerSearchLabel")}/>
          <Dialog.Close aria-label="Close"><Xmark width={17}/></Dialog.Close>
        </div>
        <Dialog.Title className="sr-only">{t(kind === "communication" ? "chooseCommunication" : "choosePms")}</Dialog.Title>
        <Dialog.Description className="sr-only">{t("pickerDescription")}</Dialog.Description>
        <div className="setup-picker-results">
          {options.map((provider, index) => {
            const enabled = canConnect(provider, kind);
            return <button key={provider.id} type="button" className="setup-picker-option" data-highlighted={index === 0 || undefined} disabled={!enabled} onClick={() => onChoose(provider)}>
              <BrandMark provider={provider.id}/>
              <span><strong>{provider.title}</strong><small>{provider.description}</small></span>
              <em>{kind === "pms" ? t(provider.id === "appfolio" ? "desktopSignIn" : "partnerAccess") : provider.authMode === "oauth2" ? "OAUTH" : provider.authMode === "qr_link" ? t("qrSignIn") : t("providerSetup")}</em>
              {enabled && <NavArrowRight width={16}/>}
            </button>;
          })}
          {!options.length && <div className="setup-picker-empty"><Search width={20}/><strong>{t("noMatchingProviders")}</strong><small>{t("tryProviderName")}</small></div>}
        </div>
        <p className="setup-picker-note">{t(kind === "pms" ? "pmsPickerNote" : "communicationPickerNote")}</p>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
