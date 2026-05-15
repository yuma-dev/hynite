import steamWebApiKeyMp4 from "../../../../../assets/onboarding/SteamWebAPI.mp4?url";
import steamGridDbApiKeyImage from "../../../../../assets/onboarding/SteamGridDB.png?url";

export type OnboardingMediaAsset =
  | {
      kind: "video";
      mp4: string;
      poster?: string;
      webm?: string;
    }
  | {
      kind: "image";
      src: string;
      alt?: string;
    };

export const onboardingMedia = {
  steamWebApiKey: {
    kind: "video",
    mp4: steamWebApiKeyMp4
  },
  steamGridDbApiKey: {
    kind: "image",
    src: steamGridDbApiKeyImage
  }
} satisfies Record<string, OnboardingMediaAsset>;
