export function unixSecondsToIso(value: number | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return new Date(value * 1000).toISOString();
}

export function communityIconUrl(appid: number, hash: string | undefined): string | undefined {
  if (!hash) {
    return undefined;
  }

  return `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${appid}/${hash}.jpg`;
}
