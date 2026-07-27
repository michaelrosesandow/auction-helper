import { describe, expect, it } from "vitest";

import {
  assignSlot,
  computeParState,
  defaultParSheet,
  reconcileParSheet,
  redistributeBalance,
  setPar,
  unassignSlot,
} from "../par-sheet.js";

describe("defaultParSheet", () => {
  it("pars sum to the total budget", () => {
    const st = computeParState(defaultParSheet());
    expect(st.parTotal).toBe(200);
    expect(st.totalBudget).toBe(200);
  });

  it("starts with nothing spent and a balanced sheet", () => {
    const st = computeParState(defaultParSheet());
    expect(st.spent).toBe(0);
    expect(st.remaining).toBe(200);
    expect(st.balance).toBe(0);
    expect(st.openSlots).toBe(15);
    expect(st.maxBid).toBe(186); // 200 - (15 - 1)
  });
});

describe("assignment + variance + balance", () => {
  it("records spend and reflects it in variance and the running balance", () => {
    const sheet = assignSlot(defaultParSheet(), "QB1", "josh-allen-qb", 40, "Josh Allen");
    const st = computeParState(sheet);
    expect(st.spent).toBe(40);
    expect(st.remaining).toBe(160);
    const qb1 = st.slots.find((s) => s.id === "QB1");
    expect(qb1?.variance).toBe(-5); // par 35 - 40
    expect(st.balance).toBe(-5); // 160 - (200 - 35)
  });

  it("clears a slot on unassign", () => {
    let sheet = assignSlot(defaultParSheet(), "RB1", "bijan-robinson-rb", 38, "Bijan Robinson");
    sheet = unassignSlot(sheet, "RB1");
    const st = computeParState(sheet);
    expect(st.spent).toBe(0);
    expect(st.slots.find((s) => s.id === "RB1")?.filled).toBe(false);
  });
});

describe("setPar", () => {
  it("updates a slot's par", () => {
    const sheet = setPar(defaultParSheet(), "SF", 45);
    expect(computeParState(sheet).slots.find((s) => s.id === "SF")?.par).toBe(45);
  });
});

describe("redistributeBalance", () => {
  it("spreads the remaining budget evenly across open slots", () => {
    let sheet = defaultParSheet();
    sheet = assignSlot(sheet, "QB1", "josh-allen-qb", 10, "Josh Allen"); // underpay by 25
    const before = computeParState(sheet);
    sheet = redistributeBalance(sheet);
    const st = computeParState(sheet);

    const openPars = st.slots.filter((s) => !s.filled).map((s) => s.par);
    expect(openPars.reduce((a, b) => a + b, 0)).toBe(before.remaining);
    expect(st.balance).toBe(0); // remaining now equals sum of open pars
    expect(st.slots.find((s) => s.id === "QB1")?.actual).toBe(10); // filled slot untouched
  });
});

describe("reconcileParSheet", () => {
  it("assigns a won player to their starter slot with the price paid", () => {
    const sheet = reconcileParSheet(defaultParSheet(), [
      { playerId: "josh-allen-qb", pos: "QB", price: 40 },
    ]);
    const qb1 = sheet.slots.find((s) => s.id === "QB1");
    expect(qb1?.playerId).toBe("josh-allen-qb");
    expect(qb1?.actual).toBe(40);
    expect(computeParState(sheet).spent).toBe(40);
  });

  it("fills starter slots before bench and sends premium picks to the top", () => {
    const sheet = reconcileParSheet(defaultParSheet(), [
      { playerId: "cheap-rb", pos: "RB", price: 2 },
      { playerId: "bijan-rb", pos: "RB", price: 60 },
    ]);
    // Expensive claims RB1; cheap takes RB2 (both before FLEX/bench).
    expect(sheet.slots.find((s) => s.id === "RB1")?.playerId).toBe("bijan-rb");
    expect(sheet.slots.find((s) => s.id === "RB2")?.playerId).toBe("cheap-rb");
  });

  it("puts a second QB in the Superflex slot once QB1 is taken", () => {
    const sheet = reconcileParSheet(defaultParSheet(), [
      { playerId: "qb1", pos: "QB", price: 40 },
      { playerId: "qb2", pos: "QB", price: 20 },
    ]);
    expect(sheet.slots.find((s) => s.id === "QB1")?.playerId).toBe("qb1");
    expect(sheet.slots.find((s) => s.id === "SF")?.playerId).toBe("qb2");
  });

  it("spills a third RB into FLEX before bench", () => {
    const sheet = reconcileParSheet(defaultParSheet(), [
      { playerId: "rb1", pos: "RB", price: 50 },
      { playerId: "rb2", pos: "RB", price: 40 },
      { playerId: "rb3", pos: "RB", price: 10 },
    ]);
    expect(sheet.slots.find((s) => s.id === "RB1")?.playerId).toBe("rb1");
    expect(sheet.slots.find((s) => s.id === "RB2")?.playerId).toBe("rb2");
    expect(sheet.slots.find((s) => s.id === "FLEX")?.playerId).toBe("rb3");
  });

  it("is add-only: a win already on the sheet is left where you put it", () => {
    // Manually park qb-a in BN1 (odd, but the user's choice).
    let sheet = assignSlot(defaultParSheet(), "BN1", "qb-a", 5);
    sheet = reconcileParSheet(sheet, [{ playerId: "qb-a", pos: "QB", price: 5 }]);
    expect(sheet.slots.find((s) => s.id === "BN1")?.playerId).toBe("qb-a");
    expect(sheet.slots.find((s) => s.id === "QB1")?.playerId).toBeUndefined();
  });

  it("is idempotent and returns the same reference when nothing changes", () => {
    const empty = defaultParSheet();
    expect(reconcileParSheet(empty, [])).toBe(empty);
    const filled = reconcileParSheet(empty, [{ playerId: "k1", pos: "K", price: 1 }]);
    expect(reconcileParSheet(filled, [{ playerId: "k1", pos: "K", price: 1 }])).toBe(filled);
  });

  it("skips a win when no eligible slot is empty", () => {
    // Fill both QB-eligible starters (QB1 + SF) and every bench slot, so a
    // third QB has nowhere legal to land and is left for manual placement.
    let sheet = defaultParSheet();
    sheet = assignSlot(sheet, "QB1", "a", 1);
    sheet = assignSlot(sheet, "SF", "b", 1);
    for (const bn of ["BN1", "BN2", "BN3", "BN4", "BN5"] as const) {
      sheet = assignSlot(sheet, bn, `fill-${bn}`, 1);
    }
    const reconciled = reconcileParSheet(sheet, [{ playerId: "stray-qb", pos: "QB", price: 1 }]);
    expect(reconciled).toBe(sheet); // nothing changed
    expect(sheet.slots.some((s) => s.playerId === "stray-qb")).toBe(false);
  });

  it("ignores roster entries with a blank playerId", () => {
    const empty = defaultParSheet();
    const sheet = reconcileParSheet(empty, [{ playerId: "", pos: "QB", price: 5 }]);
    expect(sheet).toBe(empty);
    expect(sheet.slots.every((s) => s.playerId === undefined)).toBe(true);
  });
});
