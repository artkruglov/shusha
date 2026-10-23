/**
 * Каталог «фишек» и выбор совета: постоянные номера, только существующие возможности, оговорка о коже,
 * непробованное первым, советы о фото после первого фото и только когда непробованное кончилось.
 */
import { describe, expect, it } from "vitest";

import { FEATURE_KEYS, type FeatureKey } from "../feature-uses/feature-catalog.js";
import {
  FEATURE_TIP_FIRST_LINE, FEATURE_TIPS, featureTipByNumber, formatFeatureTip, selectFeatureTip, type FeatureAvailability,
} from "./feature-tips.js";

const ALL: FeatureAvailability = { google: true, grocery: true, images: true, video: true };
const NONE: FeatureAvailability = { google: false, grocery: false, images: false, video: false };

function pick(input: { availability?: FeatureAvailability; shown?: string[]; used?: FeatureKey[] } = {}) {
  return selectFeatureTip({
    availability: input.availability ?? ALL, shown: new Set(input.shown ?? []), used: new Set(input.used ?? []),
  });
}

describe("feature tip catalog", () => {
  it("keeps numbers and keys unique and storable", () => {
    const numbers = FEATURE_TIPS.map((tip) => tip.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.every((number) => Number.isInteger(number) && number >= 1 && number <= 99)).toBe(true);
    const ids = FEATURE_TIPS.map((tip) => tip.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z_]{1,40}$/u.test(id))).toBe(true);
    expect(FEATURE_TIPS.every((tip) => (FEATURE_KEYS as readonly string[]).includes(tip.feature))).toBe(true);
    expect(FEATURE_TIPS.length).toBeGreaterThanOrEqual(14);
    expect(featureTipByNumber(1)?.id).toBe("homework");
    expect(featureTipByNumber(null)).toBeNull();
    expect(featureTipByNumber(98)).toBeNull();
  });

  it("promises nothing the bot cannot do and says the skin tip is not a diagnosis", () => {
    for (const tip of FEATURE_TIPS) {
      const words = `${tip.text} ${tip.tryText}`.toLowerCase();
      expect(words).not.toMatch(/монтаж|смонтир|видеозвон|камер[аеуы] в реальном|прямой эфир/u);
      expect(tip.text.length).toBeLessThanOrEqual(260);
    }
    const skin = FEATURE_TIPS.find((tip) => tip.id === "skin")!;
    expect(skin.text).toContain("не диагноз");
    expect(skin.tryText).toContain("врач");
    // Монтаж нигде не обещан, а видео — только оживление фото.
    expect(FEATURE_TIPS.filter((tip) => tip.feature === "video").map((tip) => tip.id)).toEqual(["animate_photo"]);
  });

  it("explains itself and how to stop only the first time", () => {
    const tip = FEATURE_TIPS[0]!;
    expect(formatFeatureTip(tip, true)).toContain(FEATURE_TIP_FIRST_LINE);
    expect(FEATURE_TIP_FIRST_LINE).toContain("Не присылать советы");
    expect(formatFeatureTip(tip, false)).not.toContain(FEATURE_TIP_FIRST_LINE);
    expect(formatFeatureTip(tip, false)).toContain(tip.text);
  });
});

describe("feature tip selection", () => {
  it("offers the first untried ability in catalog order", () => {
    expect(pick()?.id).toBe("homework");
    expect(pick({ shown: ["homework"] })?.id).toBe("voice_tasks");
    expect(pick({ shown: ["homework"], used: ["voice", "web_search"] })?.id).toBe("reminder");
  });

  it("never offers what this server cannot do", () => {
    const offered: string[] = [];
    for (;;) {
      const tip = pick({ availability: NONE, shown: offered });
      if (tip === null) break;
      offered.push(tip.id);
    }
    for (const id of ["portrait", "animate_photo", "grocery", "google"]) expect(offered).not.toContain(id);
    expect(offered).toContain("ask_anything");
  });

  it("keeps photo tips for after the untried abilities once a photo was sent", () => {
    const usedAllButPhotoTips: FeatureKey[] = FEATURE_KEYS.filter((key) => key !== "guest");
    // Фото уже присылал: сначала непробованный гостевой режим, затем по одному совету о фото.
    expect(pick({ used: usedAllButPhotoTips })?.id).toBe("guest");
    expect(pick({ shown: ["guest"], used: usedAllButPhotoTips })?.id).toBe("homework");
    expect(pick({ shown: ["guest", "homework"], used: usedAllButPhotoTips })?.id).toBe("street_photo");
    expect(pick({ shown: ["guest", "homework", "street_photo", "skin"], used: usedAllButPhotoTips })).toBeNull();
  });

  it("has nothing to say to someone who tried everything and saw every photo tip", () => {
    expect(pick({ shown: ["homework", "street_photo", "skin"], used: [...FEATURE_KEYS] })).toBeNull();
  });
});
