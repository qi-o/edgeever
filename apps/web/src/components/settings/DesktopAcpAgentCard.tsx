import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AI_SIDEBAR_ADAPTER_KEY,
  AI_SIDEBAR_ADAPTER_PATH_KEY,
  AI_SIDEBAR_SOURCE_KEY,
  listDesktopAcpAdapters,
  probeDesktopAcpAdapter,
  type AiSidebarSource,
  type DesktopAcpAdapter,
  type DesktopAcpAdapterId,
} from "@/lib/desktop-acp";
import { cn } from "@/lib/utils";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
  SETTINGS_ITEM_DESCRIPTION_CLASSNAME,
  SETTINGS_ITEM_TITLE_CLASSNAME,
} from "./settings-ui";

const adapterIds: DesktopAcpAdapterId[] = ["codex", "antigravity"];

const agentCatalog = [
  { id: "codex", connectable: true },
  { id: "antigravity", connectable: true },
  { id: "claudeCode", connectable: false },
  { id: "workbuddy", connectable: false },
  { id: "grokBuild", connectable: false },
] as const;

const readSource = (): AiSidebarSource => (
  localStorage.getItem(AI_SIDEBAR_SOURCE_KEY) === "local" ? "local" : "builtin"
);

const readAdapterId = (): DesktopAcpAdapterId => (
  localStorage.getItem(AI_SIDEBAR_ADAPTER_KEY) === "antigravity" ? "antigravity" : "codex"
);

const statusKey = (adapter: DesktopAcpAdapter | undefined, probing: boolean) => {
  if (probing) return "aiAssistant.agentSource.probing";
  if (!adapter || adapter.detail === "not_probed") return "aiAssistant.agentSource.notProbed";
  if (adapter.detail === "invalid_path") return "aiAssistant.agentSource.invalidPath";
  if (adapter.detail === "desktop_unavailable") return "aiAssistant.agentSource.localDisabled";
  return `aiAssistant.agentSource.states.${adapter.state}`;
};

const desktopBridgeAvailable = () => (
  typeof window !== "undefined" && typeof window.edgeeverDesktop?.listAcpAdapters === "function"
);

const DesktopAcpAgentCardBody = ({ bridge }: { bridge: boolean }) => {
  const { t } = useTranslation();
  const [source, setSource] = useState<AiSidebarSource>("builtin");
  const [adapterId, setAdapterId] = useState<DesktopAcpAdapterId>("codex");
  const [adapterPath, setAdapterPath] = useState("");
  const [ready, setReady] = useState(false);
  const [listed, setListed] = useState<DesktopAcpAdapter[]>([]);
  const [probed, setProbed] = useState<DesktopAcpAdapter | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    const stored = readSource();
    setSource(bridge && stored === "local" ? "local" : "builtin");
    setAdapterId(readAdapterId());
    setAdapterPath(localStorage.getItem(AI_SIDEBAR_ADAPTER_PATH_KEY) ?? "");
    setReady(true);
  }, [bridge]);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(AI_SIDEBAR_SOURCE_KEY, source);
    localStorage.setItem(AI_SIDEBAR_ADAPTER_KEY, adapterId);
    localStorage.setItem(AI_SIDEBAR_ADAPTER_PATH_KEY, adapterPath);
  }, [adapterId, adapterPath, ready, source]);

  useEffect(() => {
    let cancelled = false;
    void listDesktopAcpAdapters().then((adapters) => {
      if (!cancelled) setListed(adapters);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = probed?.id === adapterId ? probed : listed.find((adapter) => adapter.id === adapterId);
  const status = t(statusKey(shown, probing));

  const selectAdapter = (id: DesktopAcpAdapterId) => {
    setAdapterId(id);
    setProbed(null);
  };

  const probe = async () => {
    setProbing(true);
    try {
      const result = await probeDesktopAcpAdapter({
        id: adapterId,
        ...(adapterId === "antigravity" ? { path: adapterPath.trim() } : {}),
      });
      setProbed(result);
    } catch {
      setProbed({ id: adapterId, label: adapterId === "codex" ? "Codex" : "Antigravity", state: "failed" });
    } finally {
      setProbing(false);
    }
  };

  return (
    <Card className="w-full min-w-0 overflow-hidden shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>
          <Bot className={SETTINGS_CARD_ICON_CLASSNAME} />
          {t("aiAssistant.agentSource.title")}
        </CardTitle>
        <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
          {t("aiAssistant.agentSource.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 p-4 pt-0">
        <div role="radiogroup" aria-label={t("aiAssistant.agentSource.title")} className="overflow-hidden rounded-lg border border-slate-200/70 divide-y divide-slate-200/70">
          {(["builtin", "local"] as const).map((option) => {
            const disabled = option === "local" && !bridge;
            const checked = source === option;
            return (
              <div key={option} className={cn(disabled && "opacity-60", checked && "bg-slate-50/80")}>
                <label className={cn("flex items-start gap-3 px-3.5 py-2.5", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
                  <input
                    className="mt-0.5"
                    type="radio"
                    name="edgeever-acp-source"
                    value={option}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => { if (!disabled) setSource(option); }}
                  />
                  <span className="min-w-0">
                    <span className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t(`aiAssistant.agentSource.${option}`)}</span>
                    <span className={cn(SETTINGS_ITEM_DESCRIPTION_CLASSNAME, "block")}>
                      {disabled ? t("aiAssistant.agentSource.localDisabled") : t(`aiAssistant.agentSource.${option}Hint`)}
                    </span>
                  </span>
                </label>
                {disabled ? (
                  <div role="group" className="flex flex-wrap gap-2 px-3.5 pb-3 pl-9" aria-label={t("aiAssistant.agentSource.adapter")}>
                    {agentCatalog.map((agent) => (
                      <span key={agent.id} className="flex h-8 items-center gap-2 rounded-md border border-slate-200 px-2.5 text-xs text-slate-500">
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                        {t(`aiAssistant.agentSource.${agent.id}`)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {source === "local" ? (
          <div className="grid gap-3">
            <div role="radiogroup" aria-label={t("aiAssistant.agentSource.adapter")} className="flex flex-wrap gap-2">
              {adapterIds.map((id) => {
                const checked = adapterId === id;
                return (
                  <label
                    key={id}
                    className={cn(
                      "flex h-8 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-xs",
                      checked ? "border-slate-900 bg-card text-slate-950" : "border-slate-200 text-slate-600"
                    )}
                  >
                    <input
                      className="sr-only"
                      type="radio"
                      name="edgeever-acp-adapter"
                      value={id}
                      checked={checked}
                      onChange={() => selectAdapter(id)}
                    />
                    <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", checked ? "bg-slate-950" : "bg-slate-400")} />
                    {t(`aiAssistant.agentSource.${id}`)}
                  </label>
                );
              })}
              {agentCatalog.filter((agent) => !agent.connectable).map((agent) => (
                <span key={agent.id} className="flex h-8 cursor-not-allowed items-center gap-2 rounded-md border border-slate-200 px-2.5 text-xs text-slate-400">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                  {t(`aiAssistant.agentSource.${agent.id}`)}
                </span>
              ))}
            </div>

            {adapterId === "antigravity" ? (
              <label className="grid gap-1.5 text-xs font-normal leading-5 text-slate-700">
                <span className="flex items-center gap-1.5">
                  {t("aiAssistant.agentSource.pathLabel")}
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" className="text-slate-400" aria-label={t("aiAssistant.agentSource.pathHint")}>
                          <Info className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-72">{t("aiAssistant.agentSource.pathHint")}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </span>
                <Input
                  className="h-8 text-xs"
                  value={adapterPath}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder={t("aiAssistant.agentSource.pathPlaceholder")}
                  onChange={(event) => {
                    setAdapterPath(event.target.value);
                    setProbed(null);
                  }}
                />
              </label>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <p className="text-xs leading-5 text-slate-600" role="status">{status}</p>
              <Button type="button" variant="outline" size="sm" className="h-8 bg-card text-xs font-normal" disabled={probing} title={t("aiAssistant.agentSource.probeHint")} onClick={() => void probe()}>
                {probing ? t("aiAssistant.agentSource.probing") : t("aiAssistant.agentSource.probe")}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};

export const DesktopAcpAgentCard = () => (
  <DesktopAcpAgentCardBody bridge={desktopBridgeAvailable()} />
);
