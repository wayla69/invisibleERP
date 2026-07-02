import { BadRequestException } from '@nestjs/common';

// LINE Login / LIFF identity verification. A member proves they own a LINE account by presenting an
// ID token (from the shop's LIFF app or LINE Login), which we verify to obtain the stable `sub`
// (the LINE userId — the push address) and display name.
//
// Real verification calls LINE's token endpoint when LINE_LOGIN_CHANNEL_ID is configured. In dev/test
// (no channel id) we accept a deterministic `mock:<userId>[:<name>]` token so local + CI flows work
// without LINE credentials — mirroring the PSP/e-Tax mock pattern.
export interface LineProfile {
  lineUserId: string;
  displayName?: string;
}

export async function verifyLineIdToken(idToken: string | undefined): Promise<LineProfile> {
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
  if (channelId) {
    // https://developers.line.biz/en/reference/line-login/#verify-id-token
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken ?? '', client_id: channelId }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.sub) {
      throw new BadRequestException({ code: 'LINE_VERIFY_FAILED', message: body.error_description ?? `LINE token verification failed (${res.status})`, messageTh: 'ยืนยันบัญชี LINE ไม่สำเร็จ' });
    }
    return { lineUserId: String(body.sub), displayName: body.name ? String(body.name) : undefined };
  }
  // dev/test fallback: deterministic mock token.
  const m = /^mock:([^:\s]+)(?::(.*))?$/.exec((idToken ?? '').trim());
  if (!m) {
    throw new BadRequestException({ code: 'LINE_NOT_CONFIGURED', message: 'LINE login not configured (set LINE_LOGIN_CHANNEL_ID); in dev use a mock:<userId> token', messageTh: 'ยังไม่ได้ตั้งค่า LINE Login' });
  }
  return { lineUserId: m[1]!, displayName: m[2] || undefined };
}
