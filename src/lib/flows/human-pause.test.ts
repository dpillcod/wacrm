import { describe, expect, it } from "vitest";
import { humanStateOf, lastHumanReplyAt, type PauseMessage } from "./human-pause";

const T0 = Date.parse("2026-11-25T18:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const msg = (sender_type: string, min: number): PauseMessage => ({ sender_type, created_at: at(min) });
const now = (min: number) => T0 + min * 60_000;

describe("human pause", () => {
  it("only a reply to the customer counts, not the team writing first", () => {
    // The cashier's "¡Gracias por preferirnos!", then the receipt photo.
    const cashier = [msg("agent", 0), msg("customer", 1)];
    expect(lastHumanReplyAt(cashier)).toBeNull();
    expect(humanStateOf(cashier, now(2), 25, false)).toEqual({ attending: false, welcomeBack: false });
  });

  it("a person who answered keeps the bot quiet for the pause, then it's over", () => {
    const chat = [msg("customer", 0), msg("bot", 0), msg("agent", 5), msg("customer", 6), msg("agent", 8)];
    expect(humanStateOf(chat, now(20), 25, false).attending).toBe(true);
    expect(humanStateOf(chat, now(40), 25, false)).toEqual({ attending: false, welcomeBack: true });
  });

  it("closing the conversation ends the pause right away", () => {
    const chat = [msg("customer", 0), msg("agent", 2)];
    expect(humanStateOf(chat, now(5), 25, true).attending).toBe(false);
  });

  it("no welcome back once the bot already spoke, or long after", () => {
    const spoke = [msg("customer", 0), msg("agent", 2), msg("bot", 40)];
    expect(humanStateOf(spoke, now(60), 25, false).welcomeBack).toBe(false);
    const old = [msg("customer", 0), msg("agent", 2)];
    expect(humanStateOf(old, now(13 * 60), 25, false).welcomeBack).toBe(false);
  });

  it("a reply hours after the customer's last message isn't attending them", () => {
    const late = [msg("customer", 0), msg("agent", 4 * 60)];
    expect(lastHumanReplyAt(late)).toBeNull();
  });
});
