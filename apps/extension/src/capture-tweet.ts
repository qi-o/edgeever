// Injected on demand. Reads the tweet marked by tweet-target.js, or the tweet
// in the address bar when this page is a single status. Must stay import-free.
(() => {
  const root = globalThis as typeof globalThis & {
    __edgeeverTweetTarget?: boolean;
    __edgeeverTweetClipPayload?: { requestId?: string; statusId?: string };
  };
  const payload = root.__edgeeverTweetClipPayload;
  delete root.__edgeeverTweetClipPayload;
  if (!payload || typeof payload.requestId !== "string") return;
  const requestId = payload.requestId;
  const statusId = typeof payload.statusId === "string" ? payload.statusId : "";

  const finish = (result: Record<string, unknown>) => {
    void chrome.runtime.sendMessage({ type: "pageTweetRead", requestId, result });
  };

  const clean = (value: string) => value.replace(/\s+/g, " ").trim();

  const parseName = (rootNode: Element | null) => {
    if (!rootNode) return { displayName: "", handle: "" };
    const links = [...rootNode.querySelectorAll("a[href]")];
    const handleLink = links.find((link) => clean(link.textContent || "").startsWith("@"));
    const handleFromLink = clean(handleLink?.textContent || "").replace(/^@/, "").split(/\s/)[0] ?? "";
    const handleFromHref = (links.find((link) => /^\/[A-Za-z0-9_]{1,15}$/.test(link.getAttribute("href") || ""))?.getAttribute("href") || "").slice(1);
    const handle = handleFromLink || handleFromHref;
    const nameLink = links.find((link) => {
      const text = clean(link.textContent || "");
      return link !== handleLink && text.length > 0 && !text.startsWith("@");
    });
    return { displayName: clean(nameLink?.textContent || ""), handle };
  };

  const hrefMatchesStatus = (href: string, id: string) => new RegExp(`/status/${id}(?:/|\\?|$)`).test(href);

  const ownStatusHref = (article: Element) => {
    const name = [...article.querySelectorAll('[data-testid="User-Name"]')].find((node) => !node.closest('[role="link"]'))
      ?? article.querySelector('[data-testid="User-Name"]');
    return name?.querySelector("time")?.closest("a")?.getAttribute("href") ?? "";
  };

  const articleFromStatus = () => {
    if (!statusId) return null;
    return [...document.querySelectorAll('article[data-testid="tweet"]')].find((article) => hrefMatchesStatus(ownStatusHref(article), statusId)) ?? null;
  };

  const isPhoto = (src: string) => {
    if (!src || src.startsWith("blob:") || src.startsWith("data:")) return false;
    try {
      const url = new URL(src, location.href);
      const host = url.hostname.toLowerCase();
      if (host !== "pbs.twimg.com" && !host.endsWith(".twimg.com")) return false;
      const path = url.pathname.toLowerCase();
      if (path.includes("/profile_images/") || path.includes("/profile_banners/") || path.includes("/emoji/")) return false;
      if (path.includes("/amplify_video") || path.includes("/ext_tw_video") || path.includes("/tweet_video")) return false;
      return path.includes("/media/") || path.includes("/card_img/");
    } catch {
      return false;
    }
  };

  const absoluteStatus = (href: string) => {
    if (!href) return "";
    try {
      const url = new URL(href, location.href);
      const match = url.pathname.match(/\/([^/]+)\/status\/(\d+)/);
      if (!match?.[1] || !match[2]) return "";
      return `${url.origin}/${match[1]}/status/${match[2]}`;
    } catch {
      return "";
    }
  };

  try {
    const marked = document.querySelector('article[data-testid="tweet"][data-edgeever-tweet-target="1"]');
    const article = marked ?? articleFromStatus();
    if (!article) {
      finish({ ok: false, reason: root.__edgeeverTweetTarget ? "not-found" : "needs-listener" });
      return;
    }

    const names = [...article.querySelectorAll('[data-testid="User-Name"]')];
    const mainName = names.find((node) => !node.closest('[role="link"]')) ?? names[0] ?? null;
    const quoteName = names.find((node) => node !== mainName && Boolean(node.closest('[role="link"]'))) ?? null;
    const texts = [...article.querySelectorAll('[data-testid="tweetText"]')];
    const mainText = texts.find((node) => !node.closest('[role="link"]')) ?? texts[0] ?? null;
    const quoteText = texts.find((node) => node !== mainText && Boolean(node.closest('[role="link"]'))) ?? null;
    const author = parseName(mainName);
    const quoted = parseName(quoteName);
    const images: Array<{ url: string; alt: string }> = [];
    for (const img of article.querySelectorAll("img")) {
      if (img.closest('[data-testid="tweetText"]')) continue;
      if (img.closest('[data-testid="Tweet-User-Avatar"]')) continue;
      if (img.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"]')) continue;
      if (img.naturalWidth > 0 && img.naturalHeight > 0 && img.naturalWidth < 48 && img.naturalHeight < 48) continue;
      const src = img.currentSrc || img.src;
      if (!isPhoto(src) || images.some((image) => image.url === src)) continue;
      images.push({ url: src, alt: clean(img.alt) });
      if (images.length >= 6) break;
    }

    const visibleText = (node: Element | null) => {
      if (!node) return "";
      return ((node as HTMLElement).innerText || node.textContent || "").trim();
    };
    const text = visibleText(mainText);
    const quotedText = visibleText(quoteText);
    const statusUrl = absoluteStatus(ownStatusHref(article));
    if (!author.displayName && !author.handle && !text && !quotedText && images.length === 0) {
      finish({ ok: false, reason: "not-found" });
      return;
    }

    finish({
      ok: true,
      displayName: author.displayName,
      handle: author.handle,
      text,
      quotedDisplayName: quoted.displayName,
      quotedHandle: quoted.handle,
      quotedText,
      datetime: mainName?.querySelector("time")?.getAttribute("datetime") ?? "",
      statusUrl,
      images,
    });
  } catch {
    finish({ ok: false, reason: "not-found" });
  }
})();
