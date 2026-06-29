import { describe, expect, it } from "vitest";
import { buildSvg, renderOpenPencilPng, type RenderNode } from "../src/openpencil-render.js";

const PNG_MAGIC = "89504e470d0a1a0a";

describe("openpencil-render buildSvg", () => {
  it("paints children in reverse so a trailing Banner BG sits behind its title", () => {
    const nodes: RenderNode[] = [
      {
        id: "sec",
        type: "frame",
        name: "Section / 04 Foundations",
        x: 0,
        y: 0,
        width: 600,
        height: 96,
        children: [
          {
            id: "title",
            type: "text",
            name: "Section Title",
            x: 152,
            y: 22,
            width: 300,
            height: 42,
            fill: "#FFFFFF",
            fontFamily: "Inter",
            fontWeight: 700,
            fontSize: 34,
            content: "Foundations",
          },
          { id: "bg", type: "rectangle", name: "Banner BG", x: 0, y: 0, width: 600, height: 96, fill: "#0F766E" },
        ],
      },
    ];
    const { svg, width, height } = buildSvg(nodes);
    expect(width).toBe(600);
    expect(height).toBe(96);
    // The background (last child) must be painted before (behind) the title.
    const bgAt = svg.indexOf("#0F766E");
    const titleAt = svg.indexOf("Foundations");
    expect(bgAt).toBeGreaterThan(-1);
    expect(titleAt).toBeGreaterThan(-1);
    expect(bgAt).toBeLessThan(titleAt);
  });

  it("wraps long text into multiple lines within its box width", () => {
    const nodes: RenderNode[] = [
      {
        id: "t",
        type: "text",
        name: "Body",
        x: 0,
        y: 0,
        width: 80,
        height: 200,
        fill: "#111827",
        fontFamily: "Inter",
        fontWeight: 400,
        fontSize: 20,
        content: "alpha bravo charlie delta echo foxtrot golf hotel",
      },
    ];
    const { svg } = buildSvg(nodes);
    const lines = svg.match(/<tspan/g)?.length ?? 0;
    expect(lines).toBeGreaterThanOrEqual(2);
  });

  it("crops to a target node id using its own box", () => {
    const nodes: RenderNode[] = [
      {
        id: "page",
        type: "frame",
        name: "Page",
        x: 0,
        y: 0,
        width: 2000,
        height: 2000,
        children: [
          { id: "card", type: "frame", name: "Card", x: 100, y: 200, width: 320, height: 180, fill: "#EEF2FF" },
        ],
      },
    ];
    const built = buildSvg(nodes, { targetId: "card" });
    expect(built.width).toBe(320);
    expect(built.height).toBe(180);
    expect(built.targetId).toBe("card");
    expect(built.targetName).toBe("Card");
  });

  it("renders the union box and shifts it to the origin when no target is given", () => {
    const nodes: RenderNode[] = [
      { id: "a", type: "rectangle", name: "A", x: 100, y: 100, width: 200, height: 100, fill: "#000000" },
      { id: "b", type: "rectangle", name: "B", x: 400, y: 300, width: 100, height: 100, fill: "#000000" },
    ];
    const built = buildSvg(nodes);
    expect(built.width).toBe(400); // from x=100 to x=500
    expect(built.height).toBe(300); // from y=100 to y=400
  });

  it("understands the live op CLI paint-array fill shape", () => {
    const { svg } = buildSvg([
      { id: "r", type: "rectangle", name: "Card", x: 0, y: 0, width: 100, height: 60, fill: [{ type: "solid", color: "#0F766E" }] },
      { id: "t", type: "text", name: "Label", x: 4, y: 4, width: 90, height: 20, fill: [{ type: "solid", color: "#FF0000" }], fontFamily: "Inter", fontWeight: 600, fontSize: 14, content: "Hi" },
    ]);
    expect(svg).toContain("#0F766E"); // rect fill from paint array
    expect(svg).toContain("#FF0000"); // text color from paint array
  });

  it("rasterizes to a PNG when @resvg/resvg-js is available", async () => {
    const nodes: RenderNode[] = [
      {
        id: "scr",
        type: "frame",
        name: "Screen / Demo",
        x: 0,
        y: 0,
        width: 320,
        height: 200,
        fill: "#FFFFFF",
        children: [
          {
            id: "h",
            type: "text",
            name: "Heading",
            x: 16,
            y: 16,
            width: 280,
            height: 30,
            fill: "#111827",
            fontFamily: "Inter",
            fontWeight: 700,
            fontSize: 22,
            content: "Hello",
          },
        ],
      },
    ];
    try {
      const r = await renderOpenPencilPng(nodes, { targetId: "scr" });
      expect(r.png.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
      expect(r.width).toBe(320);
      expect(r.height).toBe(200);
    } catch (err) {
      // Optional dependency may be absent in minimal installs; the error must say so.
      expect(String((err as Error).message)).toMatch(/resvg/i);
    }
  });
});
