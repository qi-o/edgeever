import { describe, expect, test } from "bun:test";
import {
  filenameForImage,
  imageAltText,
  imageFromBytes,
  imageHostName,
  imageMemoMarkdown,
  imageOriginPattern,
  MAX_IMAGE_BYTES,
  noteTitleForImage,
  preferredImageUrls,
  saveCapturedImageNote,
  sniffImageMimeType,
} from "./src/image-clip.ts";

const source = {
  pageUrl: "https://x.com/huoshan007/status/1",
  capturedAt: "2026-09-26T00:00:00.000Z",
  sourceLabel: "来源",
  capturedAtLabel: "抓取时间",
};

describe("preferred image URLs", () => {
  test("asks Twitter for the original asset before the clicked preview", () => {
    const urls = preferredImageUrls("https://pbs.twimg.com/media/Abc123?format=jpg&name=small");
    expect(urls).toHaveLength(3);
    expect(new URL(urls[0]).searchParams.get("name")).toBe("orig");
    expect(new URL(urls[1]).searchParams.get("name")).toBe("large");
    expect(urls[2]).toBe("https://pbs.twimg.com/media/Abc123?format=jpg&name=small");
  });

  test("keeps an original Twitter URL as a single candidate", () => {
    const src = "https://pbs.twimg.com/media/Abc123?format=png&name=orig";
    expect(preferredImageUrls(src)).toEqual([src]);
  });

  test("upgrades the legacy Twitter size suffix and leaves other sites unchanged", () => {
    const legacy = preferredImageUrls("https://pbs.twimg.com/media/Abc.jpg:small");
    expect(new URL(legacy[0]).pathname.endsWith(":orig")).toBe(true);
    expect(legacy[1]).toBe("https://pbs.twimg.com/media/Abc.jpg:small");
    expect(preferredImageUrls("https://images.example.com/photo.png?name=small")).toEqual([
      "https://images.example.com/photo.png?name=small",
    ]);
  });
});

describe("image note content", () => {
  test("embeds the uploaded resource and the source page", () => {
    const markdown = imageMemoMarkdown({
      ...source,
      resourceId: "res_1",
      alt: "Jianying ] Headless",
      altFallback: "图片",
    });
    expect(markdown.startsWith("![Jianying Headless](/api/v1/resources/res_1/blob)")).toBe(true);
    expect(markdown).toContain("[https://x.com/huoshan007/status/1](https://x.com/huoshan007/status/1)");
    expect(markdown).not.toContain("pbs.twimg.com");
  });

  test("encodes parentheses in the source link and falls back when alt is empty", () => {
    const markdown = imageMemoMarkdown({
      ...source,
      pageUrl: "https://example.com/a(b)",
      resourceId: "res_2",
      alt: "  ",
      altFallback: "图片",
    });
    expect(markdown).toContain("![图片](/api/v1/resources/res_2/blob)");
    expect(markdown).toContain("(https://example.com/a%28b%29)");
    expect(imageAltText("]", "图片")).toBe("图片");
  });

  test("names the file from the media id and clips the note title", () => {
    expect(filenameForImage("https://pbs.twimg.com/media/Abc123?format=jpg&name=small", "image/jpeg")).toBe("Abc123.jpg");
    expect(filenameForImage("https://pbs.twimg.com/media/Abc.jpg:large", "image/png")).toBe("Abc.png");
    expect(noteTitleForImage(` ${"标".repeat(180)} `, "", "图片")).toHaveLength(160);
    expect(noteTitleForImage("  ", "卡片", "图片")).toBe("卡片");
    expect(noteTitleForImage(" ", " ", "图片")).toBe("图片");
  });

  test("reads an http image origin and ignores blob URLs", () => {
    expect(imageOriginPattern("https://pbs.twimg.com/media/Abc")).toBe("https://pbs.twimg.com/*");
    expect(imageHostName("https://pbs.twimg.com/media/Abc")).toBe("pbs.twimg.com");
    expect(imageOriginPattern("blob:https://x.com/8fb53d6f")).toBeNull();
    expect(imageHostName("data:image/png;base64,aaaa")).toBe("");
  });
});

describe("image bytes", () => {
  test("recognizes common image signatures and rejects other payloads", () => {
    expect(sniffImageMimeType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d))).toBe("image/png");
    expect(sniffImageMimeType(Uint8Array.of(0xff, 0xd8, 0xff, 0x00))).toBe("image/jpeg");
    expect(sniffImageMimeType(Uint8Array.of(0x47, 0x49, 0x46, 0x38))).toBe("image/gif");
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImageMimeType(webp)).toBe("image/webp");
    const avif = new Uint8Array(12);
    avif.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    expect(sniffImageMimeType(avif)).toBe("image/avif");
    expect(imageFromBytes(Uint8Array.of(0x89, 0x50, 0x4e, 0x47), "").mimeType).toBe("image/png");
    expect(imageFromBytes(Uint8Array.of(0x3c, 0x68, 0x74, 0x6d, 0x6c), "text/html")).toEqual({ error: "unsupported" });
    expect(imageFromBytes(new Uint8Array(), "image/png")).toEqual({ error: "empty" });
    expect(imageFromBytes(new Uint8Array(MAX_IMAGE_BYTES + 1), "image/png")).toEqual({ error: "too-large" });
    expect(imageFromBytes(Uint8Array.of(1, 2, 3), "image/jpg").mimeType).toBe("image/jpeg");
  });
});

describe("saveCapturedImageNote", () => {
  const image = {
    notebookId: "nb_inbox",
    title: "火山哥 on X",
    alt: "卡片",
    filename: "Abc123.jpg",
    mimeType: "image/jpeg",
    bytes: Uint8Array.of(0xff, 0xd8, 0xff),
    ...source,
    altFallback: "图片",
  };

  const client = (overrides = {}) => {
    const order = [];
    const calls = { deleted: [], saved: null, created: null };
    return {
      order,
      calls,
      api: {
        listNotebooks: async () => {
          order.push("list");
          return { notebooks: [{ id: "nb_first" }] };
        },
        createMemo: async (body) => {
          order.push("create");
          calls.created = body;
          return { memo: { id: "memo_1" } };
        },
        uploadImage: async () => {
          order.push("upload");
          return { id: "res_1" };
        },
        createEditSession: async () => {
          order.push("session");
          return { editSession: { id: "edit_1", baseRevision: 0, baseContentHash: "a".repeat(64) } };
        },
        saveMemo: async (_memoId, body) => {
          order.push("save");
          calls.saved = body;
        },
        deleteMemo: async (memoId) => {
          order.push("delete");
          calls.deleted.push(memoId);
        },
        ...overrides,
      },
    };
  };

  test("creates a note, uploads the image, then saves it into the note", async () => {
    const fixture = client();
    const saved = await saveCapturedImageNote(fixture.api, image);
    expect(saved).toEqual({ memoId: "memo_1", resourceId: "res_1" });
    expect(fixture.order).toEqual(["create", "upload", "session", "save"]);
    expect(fixture.calls.created.notebookId).toBe("nb_inbox");
    expect(fixture.calls.created.tags).toEqual(["web-clip"]);
    expect(fixture.calls.created.contentMarkdown.startsWith("![")).toBe(false);
    expect(fixture.calls.saved.editSessionId).toBe("edit_1");
    expect(fixture.calls.saved.expectedRevision).toBe(0);
    expect(fixture.calls.saved.expectedContentHash).toBe("a".repeat(64));
    expect(fixture.calls.saved.contentMarkdown).toContain("](/api/v1/resources/res_1/blob)");
    expect(fixture.calls.deleted).toEqual([]);
  });

  test("uses the first notebook when none is selected", async () => {
    const fixture = client();
    await saveCapturedImageNote(fixture.api, { ...image, notebookId: "" });
    expect(fixture.order[0]).toBe("list");
    expect(fixture.calls.created.notebookId).toBe("nb_first");
  });

  test("deletes the new note when the image upload fails", async () => {
    const fixture = client({
      uploadImage: async () => {
        throw new Error("Missing required scope: write:resources");
      },
    });
    await expect(saveCapturedImageNote(fixture.api, image)).rejects.toThrow("write:resources");
    expect(fixture.calls.deleted).toEqual(["memo_1"]);
    expect(fixture.order).toEqual(["create", "delete"]);
  });

  test("does not delete anything when no notebook exists", async () => {
    const fixture = client({
      listNotebooks: async () => ({ notebooks: [] }),
    });
    await expect(saveCapturedImageNote(fixture.api, { ...image, notebookId: "" })).rejects.toThrow("no-notebook");
    expect(fixture.calls.deleted).toEqual([]);
  });
});
