import { describe, expect, it } from "vitest";

import {
  assignSlot,
  computeParState,
  defaultParSheet,
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
