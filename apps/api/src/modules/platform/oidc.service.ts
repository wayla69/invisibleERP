import { Injectable, ServiceUnavailableException } from '@nestjs/common';

/**
 * SSO seam (move #7) — OIDC scaffold only.
 *
 * Documented interface; real token/JWKS exchange is intentionally NOT implemented.
 * Activates only when OIDC_ISSUER env is set; otherwise every method throws NOT_CONFIGURED.
 *
 * Env (when wired):
 *   OIDC_ISSUER        — e.g. https://login.example.com
 *   OIDC_CLIENT_ID
 *   OIDC_CLIENT_SECRET
 *   OIDC_REDIRECT_URI  — callback URL registered with the IdP
 */
@Injectable()
export class OidcService {
  private get issuer(): string | undefined {
    return process.env.OIDC_ISSUER;
  }

  isConfigured(): boolean {
    return !!this.issuer;
  }

  private ensureConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException({
        code: 'NOT_CONFIGURED',
        message: 'SSO/OIDC is not configured (set OIDC_ISSUER)',
        messageTh: 'ยังไม่ได้ตั้งค่า SSO/OIDC',
      });
    }
  }

  /**
   * Build the IdP authorization redirect URL.
   * @param state opaque CSRF/state token the caller persists and re-checks on callback.
   * @returns absolute URL to redirect the browser to.
   */
  authorizationUrl(state: string): string {
    this.ensureConfigured();
    const clientId = process.env.OIDC_CLIENT_ID ?? '';
    const redirect = process.env.OIDC_REDIRECT_URI ?? '';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      scope: 'openid email profile',
      state,
    });
    return `${this.issuer}/authorize?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for the verified identity.
   * Scaffold: throws NOT_CONFIGURED until a real implementation (token exchange +
   * id_token signature/claims validation against the issuer JWKS) is added.
   * @param code authorization code returned by the IdP on the redirect.
   * @returns the federated subject + email to map onto users.ssoSubject.
   */
  async handleCallback(code: string): Promise<{ subject: string; email: string }> {
    this.ensureConfigured();
    void code;
    // TODO: POST {issuer}/token, validate id_token against {issuer}/jwks, map claims.
    throw new ServiceUnavailableException({
      code: 'NOT_CONFIGURED',
      message: 'OIDC callback handling not implemented',
      messageTh: 'ยังไม่ได้ติดตั้งการรับ callback OIDC',
    });
  }
}
