package handlers

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	"offdock/internal/crypto"
	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// oauthSettingsSnapshot returns a copy of oauthSettings under a read lock.
// All read paths must use this instead of accessing h.oauthSettings directly.
func (h *H) oauthSettingsSnapshot() store.OAuthSettings {
	h.settingsMu.RLock()
	defer h.settingsMu.RUnlock()
	return h.oauthSettings
}

// ─── Public status (no auth required) ────────────────────────────────────────

// OAuthStatus returns whether OAuth2 login is ready to use. Called by the login
// page (unauthenticated) to decide whether to show the SSO button.
// Returns ready=true only when enabled=true AND issuer+clientID are configured.
func (h *H) OAuthStatus(w http.ResponseWriter, r *http.Request) {
	s := h.oauthSettingsSnapshot()
	ready := s.Enabled && strings.TrimSpace(s.Issuer) != "" && strings.TrimSpace(s.ClientID) != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": ready,
		"issuer":  s.Issuer,
	})
}

// OAuthLogout clears the Offdock session cookie and redirects to the IdP's
// RP-initiated logout endpoint so the SSO session is also terminated.
func (h *H) OAuthLogout(w http.ResponseWriter, r *http.Request) {
	// Revoke server-side session if present.
	cookie, err := r.Cookie("offdock_token")
	if err == nil && cookie.Value != "" {
		if claims, err := h.auth.Verify(cookie.Value); err == nil && claims.SessionID != "" {
			if sess, err := h.db.Sessions.FindByID(claims.SessionID); err == nil {
				sess.Revoked = true
				h.db.Sessions.Save(sess) //nolint:errcheck
			}
		}
	}

	// Clear the Offdock JWT cookie.
	http.SetCookie(w, &http.Cookie{
		Name:    "offdock_token",
		Value:   "",
		Path:    "/",
		HttpOnly: true,
		Expires: time.Unix(0, 0),
		MaxAge:  -1,
	})

	// Build post-logout redirect URI (back to Offdock login page).
	postLogoutURI := ""
	oauthCfgLogout := h.oauthSettingsSnapshot()
	if oauthCfgLogout.RedirectURI != "" {
		// Strip /api/v1/auth/oauth/callback suffix to get the base URL.
		base := strings.TrimSuffix(oauthCfgLogout.RedirectURI, "/api/v1/auth/oauth/callback")
		base = strings.TrimRight(base, "/")
		postLogoutURI = base + "/login"
	}

	oauthCfg2 := h.oauthSettingsSnapshot()
	if oauthCfg2.Enabled && oauthCfg2.Issuer != "" {
		logoutURL := buildLogoutURL(strings.TrimRight(oauthCfg2.Issuer, "/"))
		if postLogoutURI != "" {
			logoutURL += "?post_logout_redirect_uri=" + url.QueryEscape(postLogoutURI)
		}
		http.Redirect(w, r, logoutURL, http.StatusFound)
		return
	}

	// Fall back to local logout redirect.
	target := "/login"
	if postLogoutURI != "" {
		target = postLogoutURI
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// ─── Settings ────────────────────────────────────────────────────────────────

// GetOAuthSettings returns current OAuth2 configuration (secret masked).
func (h *H) GetOAuthSettings(w http.ResponseWriter, r *http.Request) {
	s := h.oauthSettingsSnapshot()
	claimSub, claimEmail, claimUsername, claimName, claimFirst, claimLast := s.EffectiveClaimNames()
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":         s.Enabled,
		"issuer":          s.Issuer,
		"client_id":       s.ClientID,
		"secret_set":      s.ClientSecret != "",
		"redirect_uri":    s.RedirectURI,
		"scope":           s.Scope,
		"claim_sub":       claimSub,
		"claim_email":     claimEmail,
		"claim_username":  claimUsername,
		"claim_name":      claimName,
		"claim_first":     claimFirst,
		"claim_last":      claimLast,
		"ca_cert_file":    s.CACertFile,
		"tls_skip_verify": s.TLSSkipVerify,
	})
}

// SaveOAuthSettings persists OAuth2 configuration to config.yaml (superadmin only).
func (h *H) SaveOAuthSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled       bool   `json:"enabled"`
		Issuer        string `json:"issuer"`
		ClientID      string `json:"client_id"`
		ClientSecret  string `json:"client_secret"`
		RedirectURI   string `json:"redirect_uri"`
		Scope         string `json:"scope"`
		ClaimSub      string `json:"claim_sub"`
		ClaimEmail    string `json:"claim_email"`
		ClaimUsername string `json:"claim_username"`
		ClaimName     string `json:"claim_name"`
		ClaimFirst    string `json:"claim_first"`
		ClaimLast     string `json:"claim_last"`
		CACertFile    string `json:"ca_cert_file"`
		TLSSkipVerify bool   `json:"tls_skip_verify"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// Allow saving incomplete config — OAuthStatus will only advertise enabled=true
	// once all required fields are present, so the login button won't appear until
	// the user has fully configured the IdP.

	// Keep existing secret if not provided.
	h.settingsMu.RLock()
	existingSecret := h.oauthSettings.ClientSecret
	h.settingsMu.RUnlock()
	secret := req.ClientSecret
	if secret == "" {
		secret = existingSecret
	}
	if req.Scope == "" {
		req.Scope = "openid profile email"
	}

	newSettings := store.OAuthSettings{
		Enabled:       req.Enabled,
		Issuer:        strings.TrimRight(req.Issuer, "/"),
		ClientID:      req.ClientID,
		ClientSecret:  secret,
		RedirectURI:   req.RedirectURI,
		Scope:         req.Scope,
		ClaimSub:      req.ClaimSub,
		ClaimEmail:    req.ClaimEmail,
		ClaimUsername: req.ClaimUsername,
		ClaimName:     req.ClaimName,
		ClaimFirst:    req.ClaimFirst,
		ClaimLast:     req.ClaimLast,
		CACertFile:    req.CACertFile,
		TLSSkipVerify: req.TLSSkipVerify,
	}

	if err := updateOAuthConfigYAML(newSettings); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  "applied (could not persist: " + err.Error() + ")",
			"warning": "settings will reset on service restart — fix /etc/offdock/config.yaml permissions",
		})
		return
	}

	h.settingsMu.Lock()
	h.oauthSettings = newSettings
	h.settingsMu.Unlock()

	h.logAudit(r, "update_oauth_settings", "system", "", req.Issuer, "")
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

// ─── TLS-aware HTTP client ────────────────────────────────────────────────────

// oauthHTTPClient builds an *http.Client that trusts the configured CA cert and
// optionally skips TLS verification for OAuth2/OIDC requests to the IdP.
func (h *H) oauthHTTPClient() *http.Client {
	s := h.oauthSettingsSnapshot()
	tlsCfg := &tls.Config{
		InsecureSkipVerify: s.TLSSkipVerify, //nolint:gosec
	}
	if s.CACertFile != "" && !s.TLSSkipVerify {
		if pool := crypto.LoadCACertPool(s.CACertFile); pool != nil {
			tlsCfg.RootCAs = pool
		}
	}
	return &http.Client{
		Transport: &http.Transport{TLSClientConfig: tlsCfg},
		Timeout:   20 * time.Second,
	}
}

// ─── OAuth2 Flow ─────────────────────────────────────────────────────────────

// OAuthStart builds the authorization URL and redirects the browser to the IdP.
// Query param: ?force=true → adds prompt=login to force re-authentication.
func (h *H) OAuthStart(w http.ResponseWriter, r *http.Request) {
	oauthCfg := h.oauthSettingsSnapshot()
	if !oauthCfg.Enabled || oauthCfg.Issuer == "" {
		writeError(w, http.StatusUnprocessableEntity, "OAuth2 login is not configured or disabled")
		return
	}

	// Generate CSRF state (32 random bytes → hex).
	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		writeError(w, http.StatusInternalServerError, "could not generate state")
		return
	}
	state := fmt.Sprintf("%x", stateBytes)

	// Generate PKCE code verifier (43–128 chars, base64url, no padding).
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		writeError(w, http.StatusInternalServerError, "could not generate PKCE verifier")
		return
	}
	codeVerifier := base64.RawURLEncoding.EncodeToString(verifierBytes)

	// S256 code challenge = base64url(SHA256(verifier)).
	h256 := sha256.Sum256([]byte(codeVerifier))
	codeChallenge := base64.RawURLEncoding.EncodeToString(h256[:])

	// Store state+verifier in a signed cookie so we can verify on callback.
	payload := base64.RawURLEncoding.EncodeToString([]byte(state + "|" + codeVerifier))
	sig := h.auth.HMACSign(payload)
	cookieVal := payload + "." + sig
	http.SetCookie(w, &http.Cookie{
		Name:     "offdock_oauth_state",
		Value:    cookieVal,
		Path:     "/api/v1/auth/oauth/callback",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   300,
	})

	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", oauthCfg.ClientID)
	q.Set("redirect_uri", oauthCfg.RedirectURI)
	q.Set("scope", oauthCfg.Scope)
	q.Set("state", state)
	q.Set("code_challenge", codeChallenge)
	q.Set("code_challenge_method", "S256")
	// Always use prompt=login so the IdP always shows the login screen
	// even when the user has a saved SSO session. This prevents session
	// confusion when multiple accounts exist. ?force=true is kept for
	// backwards compatibility but no longer needed.
	q.Set("prompt", "login")

	// Build authorization URL. Try OIDC discovery first to find the exact endpoint,
	// then fall back to common IdP path conventions.
	authURL := buildAuthURL(oauthCfg.Issuer) + "?" + q.Encode()
	http.Redirect(w, r, authURL, http.StatusFound)
}

// ─── IdP URL builders ─────────────────────────────────────────────────────────
// These handle differences between Keycloak (/realms/<name>/protocol/openid-connect/*)
// and standard OIDC issuers (/oauth2/*). Add cases here as new IdPs are supported.

func buildAuthURL(issuer string) string {
	if strings.Contains(issuer, "/realms/") {
		return issuer + "/protocol/openid-connect/auth"
	}
	return issuer + "/oauth2/authorize"
}

func buildTokenURL(issuer string) string {
	if strings.Contains(issuer, "/realms/") {
		return issuer + "/protocol/openid-connect/token"
	}
	return issuer + "/oauth2/token"
}

func buildUserInfoURL(issuer string) string {
	if strings.Contains(issuer, "/realms/") {
		return issuer + "/protocol/openid-connect/userinfo"
	}
	return issuer + "/oauth2/userinfo"
}

func buildLogoutURL(issuer string) string {
	if strings.Contains(issuer, "/realms/") {
		return issuer + "/protocol/openid-connect/logout"
	}
	return issuer + "/oauth2/logout"
}

// OAuthCallback handles the IdP redirect back with code+state, exchanges the code
// for tokens, verifies the access token, upserts the user, and issues an Offdock session.
func (h *H) OAuthCallback(w http.ResponseWriter, r *http.Request) {
	if !h.oauthSettingsSnapshot().Enabled {
		writeError(w, http.StatusUnprocessableEntity, "OAuth2 login is disabled")
		return
	}

	// Check for IdP error.
	if errParam := r.URL.Query().Get("error"); errParam != "" {
		desc := r.URL.Query().Get("error_description")
		http.Redirect(w, r, "/login?error="+url.QueryEscape(errParam+": "+desc), http.StatusFound)
		return
	}

	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		http.Redirect(w, r, "/login?error=missing+code+or+state", http.StatusFound)
		return
	}

	// Verify state + recover PKCE verifier from signed cookie.
	cookie, err := r.Cookie("offdock_oauth_state")
	if err != nil {
		http.Redirect(w, r, "/login?error=missing+oauth+state+cookie", http.StatusFound)
		return
	}

	parts := strings.SplitN(cookie.Value, ".", 2)
	if len(parts) != 2 || !h.auth.HMACVerify(parts[0], parts[1]) {
		http.Redirect(w, r, "/login?error=invalid+oauth+state+cookie", http.StatusFound)
		return
	}

	decoded, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		http.Redirect(w, r, "/login?error=malformed+state+cookie", http.StatusFound)
		return
	}

	stateParts := strings.SplitN(string(decoded), "|", 2)
	if len(stateParts) != 2 || stateParts[0] != state {
		http.Redirect(w, r, "/login?error=state+mismatch", http.StatusFound)
		return
	}
	codeVerifier := stateParts[1]

	// Clear the state cookie.
	http.SetCookie(w, &http.Cookie{
		Name:    "offdock_oauth_state",
		Value:   "",
		Path:    "/api/v1/auth/oauth/callback",
		MaxAge:  -1,
		Expires: time.Unix(0, 0),
	})

	// Exchange code for tokens.
	claims, err := h.exchangeCodeForClaims(code, codeVerifier)
	if err != nil {
		http.Redirect(w, r, "/login?error="+url.QueryEscape("token exchange failed: "+err.Error()), http.StatusFound)
		return
	}

	// Upsert user.
	user, err := h.upsertOAuthUser(claims)
	if err != nil {
		http.Redirect(w, r, "/login?error="+url.QueryEscape("user provisioning failed: "+err.Error()), http.StatusFound)
		return
	}

	// Create session and issue JWT cookie.
	now := timeNow()
	session := store.Session{
		ID:        store.NewULID(),
		UserID:    user.ID,
		Username:  user.Username,
		IP:        authmw.RealIP(r),
		UserAgent: r.UserAgent(),
		CreatedAt: now,
		LastSeen:  now,
	}
	if err := h.db.Sessions.Save(session); err != nil {
		http.Redirect(w, r, "/login?error=could+not+create+session", http.StatusFound)
		return
	}

	token, err := h.auth.Issue(*user, session.ID)
	if err != nil {
		http.Redirect(w, r, "/login?error=could+not+issue+token", http.StatusFound)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "offdock_token",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Expires:  time.Now().Add(8 * time.Hour),
	})

	h.logAuditDirect(user.ID, user.Username, authmw.RealIP(r), r.UserAgent(), "oauth_login", "user", user.ID, user.Username, h.oauthSettingsSnapshot().Issuer)
	http.Redirect(w, r, "/", http.StatusFound)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// oauthClaims holds the raw claims map from userinfo/JWT so we can apply
// dynamic claim name mappings configured by the admin.
type oauthClaims struct {
	Sub         string
	Email       string
	Username    string
	DisplayName string
	Raw         map[string]interface{}
}

// exchangeCodeForClaims exchanges an authorization code for an access token,
// then fetches user claims from the IdP's /oauth2/userinfo endpoint.
func (h *H) exchangeCodeForClaims(code, codeVerifier string) (*oauthClaims, error) {
	cfg := h.oauthSettingsSnapshot()
	issuer := strings.TrimRight(cfg.Issuer, "/")
	tokenURL := buildTokenURL(issuer)

	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", cfg.RedirectURI)
	form.Set("client_id", cfg.ClientID)
	form.Set("code_verifier", codeVerifier)
	if cfg.ClientSecret != "" {
		form.Set("client_secret", cfg.ClientSecret)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := h.oauthHTTPClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("token endpoint: %w", err)
	}
	defer resp.Body.Close()

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return nil, fmt.Errorf("decode token response: %w", err)
	}
	if tokenResp.Error != "" {
		return nil, fmt.Errorf("%s: %s", tokenResp.Error, tokenResp.ErrorDesc)
	}
	if tokenResp.AccessToken == "" {
		return nil, fmt.Errorf("no access token in response")
	}

	// Use the userinfo endpoint exclusively — never parse JWT without signature verification.
	// If userinfo fails, we reject the login rather than accept unverified identity claims.
	claims, err := h.fetchUserInfo(tokenResp.AccessToken)
	if err != nil {
		return nil, fmt.Errorf("userinfo request failed: %w — check issuer URL and TLS settings", err)
	}
	return claims, nil
}

// fetchUserInfo calls the IdP's /oauth2/userinfo endpoint with the access token.
func (h *H) fetchUserInfo(accessToken string) (*oauthClaims, error) {
	userInfoURL := buildUserInfoURL(strings.TrimRight(h.oauthSettingsSnapshot().Issuer, "/"))

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, userInfoURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := h.oauthHTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("userinfo returned %d", resp.StatusCode)
	}

	var raw map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	return h.mapClaims(raw)
}

// mapClaims converts a raw claims map to oauthClaims using the configured field names.
// Uses fallback chains for email and display name to handle AO ID LDAP claims
// (mail/cn/givenName/sn/uid) as well as standard OIDC claims (email/name/preferred_username).
func (h *H) mapClaims(raw map[string]interface{}) (*oauthClaims, error) {
	claimSub, claimEmail, claimUsername, claimName, claimFirst, claimLast := h.oauthSettingsSnapshot().EffectiveClaimNames()

	str := func(key string) string {
		if v, ok := raw[key]; ok {
			if s, ok := v.(string); ok {
				return strings.TrimSpace(s)
			}
		}
		return ""
	}
	firstNonEmpty := func(vals ...string) string {
		for _, v := range vals {
			if v != "" {
				return v
			}
		}
		return ""
	}

	sub := str(claimSub)

	// Email: try configured claim → OIDC "email" fallback → sub as last resort.
	email := firstNonEmpty(str(claimEmail), str("email"), sub)

	// Username: try configured claim → OIDC "preferred_username" → sub.
	username := firstNonEmpty(str(claimUsername), str("preferred_username"), sub)

	// Display name: try full-name claim (cn) → compose from first+last (givenName+sn)
	// → username claim (uid) → OIDC preferred_username.
	givenName := str(claimFirst)
	surname := str(claimLast)
	composedName := strings.TrimSpace(givenName + " " + surname)
	displayName := firstNonEmpty(str(claimName), composedName, str(claimUsername), str("preferred_username"))

	c := &oauthClaims{
		Sub:         sub,
		Email:       email,
		Username:    username,
		DisplayName: displayName,
		Raw:         raw,
	}
	if c.Sub == "" {
		return nil, fmt.Errorf("'%s' (sub) claim missing in userinfo response", claimSub)
	}
	return c, nil
}

// upsertOAuthUser finds or creates an Offdock user for the given OAuth claims.
// Lookup order: by OAuthSubject (sub), then by Username (ldap_username), then create new.
func (h *H) upsertOAuthUser(claims *oauthClaims) (*store.User, error) {
	// 1. Try to find by sub.
	matches, _ := h.db.Users.FindWhere(func(u store.User) bool {
		return u.OAuthSubject == claims.Sub && u.OAuthProvider == "ao_id"
	})
	if len(matches) > 0 {
		u := matches[0]
		// Refresh mutable attributes from IdP on every login.
		if claims.Email != "" {
			u.Email = claims.Email
		}
		if claims.Username != "" && claims.Username != u.Username {
			// Username changed at the IdP (e.g. uid claim updated) — sync it.
			u.Username = claims.Username
		}
		u.UpdatedAt = timeNow()
		if err := h.db.Users.Save(u); err != nil {
			return nil, err
		}
		slog.Info("oauth_login_refresh", "user_id", u.ID, "username", u.Username, "provider", u.OAuthProvider)
		return &u, nil
	}

	// 2. Try to link to an existing local account by username.
	username := claims.Username
	if username == "" {
		username = claims.Sub // fallback to sub if no username claim
	}
	byName, _ := h.db.Users.FindWhere(func(u store.User) bool {
		return u.Username == username
	})
	if len(byName) > 0 {
		u := byName[0]
		u.OAuthSubject = claims.Sub
		u.OAuthProvider = "ao_id"
		if claims.Email != "" {
			u.Email = claims.Email
		}
		u.UpdatedAt = timeNow()
		if err := h.db.Users.Save(u); err != nil {
			return nil, err
		}
		return &u, nil
	}

	// 3. Create a new viewer account provisioned by OAuth.
	now := timeNow()
	u := store.User{
		ID:            store.NewULID(),
		Username:      username,
		Email:         claims.Email,
		PasswordHash:  "", // no local password for OAuth-only users
		Role:          store.RoleViewer,
		OAuthSubject:  claims.Sub,
		OAuthProvider: "ao_id",
		CreatedBy:     "oauth",
		CreatedAt:     now,
		UpdatedAt:     now,
		Active:        true,
	}
	if err := h.db.Users.Save(u); err != nil {
		return nil, err
	}
	return &u, nil
}

// ─── Config persistence ───────────────────────────────────────────────────────

func updateOAuthConfigYAML(s store.OAuthSettings) error {
	const configPath = "/etc/offdock/config.yaml"
	data, err := readFileString(configPath)
	if err != nil {
		return err
	}

	claimSub, claimEmail, claimUsername, claimName, claimFirst, claimLast := s.EffectiveClaimNames()
	updates := map[string]string{
		"oauth_enabled":         boolStr(s.Enabled),
		"oauth_issuer":          s.Issuer,
		"oauth_client_id":       s.ClientID,
		"oauth_redirect_uri":    s.RedirectURI,
		"oauth_scope":           s.Scope,
		"oauth_claim_sub":       claimSub,
		"oauth_claim_email":     claimEmail,
		"oauth_claim_username":  claimUsername,
		"oauth_claim_name":      claimName,
		"oauth_claim_first":     claimFirst,
		"oauth_claim_last":      claimLast,
		"oauth_ca_cert_file":    s.CACertFile,
		"oauth_tls_skip_verify": boolStr(s.TLSSkipVerify),
	}
	if s.ClientSecret != "" {
		updates["oauth_client_secret"] = s.ClientSecret
	}

	lines := strings.Split(data, "\n")
	set := make(map[string]bool)
	for i, line := range lines {
		for k, v := range updates {
			if strings.HasPrefix(strings.TrimSpace(line), k+":") {
				lines[i] = k + ": " + v
				set[k] = true
			}
		}
	}
	for k, v := range updates {
		if !set[k] {
			lines = append(lines, k+": "+v)
		}
	}

	return writeFileAtomic(configPath, strings.Join(lines, "\n"))
}

// ─── JWKS / RSA verification (unused if userinfo succeeds, kept for completeness) ─

// jwksKey represents a single RSA key from a JWKS endpoint.
type jwksKey struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// parseRSAPublicKey decodes a JWKS key into an *rsa.PublicKey.
func parseRSAPublicKey(k jwksKey) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, fmt.Errorf("decode N: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, fmt.Errorf("decode E: %w", err)
	}

	// Pad eBytes to 4 bytes for big-endian uint32.
	if len(eBytes) < 4 {
		padded := make([]byte, 4)
		copy(padded[4-len(eBytes):], eBytes)
		eBytes = padded
	}
	e := int(binary.BigEndian.Uint32(eBytes))

	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: e,
	}, nil
}

// logAuditDirect writes an audit event without an HTTP request context.
func (h *H) logAuditDirect(userID, username, ip, ua, action, resourceType, resourceID, resourceName, details string) {
	event := store.AuditEvent{
		ID:           store.NewULID(),
		UserID:       userID,
		Username:     username,
		Action:       action,
		ResourceType: resourceType,
		ResourceID:   resourceID,
		ResourceName: resourceName,
		Details:      details,
		IPAddr:       ip,
		CreatedAt:    timeNow(),
	}
	h.db.AuditEvents.Save(event) //nolint:errcheck
}
