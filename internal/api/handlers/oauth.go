package handlers

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// ─── Public status (no auth required) ────────────────────────────────────────

// OAuthStatus returns whether OAuth2 login is enabled. Called by the login page
// before the user is authenticated so it knows whether to show the SSO button.
func (h *H) OAuthStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": h.oauthSettings.Enabled && h.oauthSettings.Issuer != "" && h.oauthSettings.ClientID != "",
		"issuer":  h.oauthSettings.Issuer,
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
	if h.oauthSettings.RedirectURI != "" {
		// Strip /api/v1/auth/oauth/callback suffix to get the base URL.
		base := strings.TrimSuffix(h.oauthSettings.RedirectURI, "/api/v1/auth/oauth/callback")
		base = strings.TrimRight(base, "/")
		postLogoutURI = base + "/login"
	}

	if h.oauthSettings.Enabled && h.oauthSettings.Issuer != "" {
		logoutURL := h.oauthSettings.Issuer + "/oauth2/logout"
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
	s := h.oauthSettings
	claimSub, claimEmail, claimUsername, claimName := s.EffectiveClaimNames()
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":        s.Enabled,
		"issuer":         s.Issuer,
		"client_id":      s.ClientID,
		"secret_set":     s.ClientSecret != "",
		"redirect_uri":   s.RedirectURI,
		"scope":          s.Scope,
		"claim_sub":      claimSub,
		"claim_email":    claimEmail,
		"claim_username": claimUsername,
		"claim_name":     claimName,
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
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Enabled && (req.Issuer == "" || req.ClientID == "" || req.RedirectURI == "") {
		writeError(w, http.StatusBadRequest, "issuer, client_id, and redirect_uri are required when enabled")
		return
	}

	// Keep existing secret if not provided.
	secret := req.ClientSecret
	if secret == "" {
		secret = h.oauthSettings.ClientSecret
	}
	if req.Scope == "" {
		req.Scope = "openid profile email"
	}

	h.oauthSettings = store.OAuthSettings{
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
	}

	if err := updateOAuthConfigYAML(h.oauthSettings); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  "applied (could not persist: " + err.Error() + ")",
			"warning": "settings will reset on service restart — fix /etc/offdock/config.yaml permissions",
		})
		return
	}

	h.logAudit(r, "update_oauth_settings", "system", "", req.Issuer, "")
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

// ─── OAuth2 Flow ─────────────────────────────────────────────────────────────

// OAuthStart builds the authorization URL and redirects the browser to the IdP.
// Query param: ?force=true → adds prompt=login to force re-authentication.
func (h *H) OAuthStart(w http.ResponseWriter, r *http.Request) {
	if !h.oauthSettings.Enabled || h.oauthSettings.Issuer == "" {
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
	q.Set("client_id", h.oauthSettings.ClientID)
	q.Set("redirect_uri", h.oauthSettings.RedirectURI)
	q.Set("scope", h.oauthSettings.Scope)
	q.Set("state", state)
	q.Set("code_challenge", codeChallenge)
	q.Set("code_challenge_method", "S256")
	if r.URL.Query().Get("force") == "true" {
		q.Set("prompt", "login")
	}

	authURL := h.oauthSettings.Issuer + "/oauth2/authorize?" + q.Encode()
	http.Redirect(w, r, authURL, http.StatusFound)
}

// OAuthCallback handles the IdP redirect back with code+state, exchanges the code
// for tokens, verifies the access token, upserts the user, and issues an Offdock session.
func (h *H) OAuthCallback(w http.ResponseWriter, r *http.Request) {
	if !h.oauthSettings.Enabled {
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

	h.logAuditDirect(user.ID, user.Username, authmw.RealIP(r), r.UserAgent(), "oauth_login", "user", user.ID, user.Username, h.oauthSettings.Issuer)
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
	issuer := h.oauthSettings.Issuer
	tokenURL := issuer + "/oauth2/token"

	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", h.oauthSettings.RedirectURI)
	form.Set("client_id", h.oauthSettings.ClientID)
	form.Set("code_verifier", codeVerifier)
	if h.oauthSettings.ClientSecret != "" {
		form.Set("client_secret", h.oauthSettings.ClientSecret)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
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

	// Use userinfo endpoint to get claims (avoids needing to verify RS256 JWT locally
	// when the IdP might rotate keys).
	claims, err := h.fetchUserInfo(tokenResp.AccessToken)
	if err != nil {
		// Fall back to parsing JWT claims without signature verification if userinfo fails.
		claims, err = h.parseJWTClaimsUnsafe(tokenResp.AccessToken)
		if err != nil {
			return nil, fmt.Errorf("could not get claims: %w", err)
		}
	}
	return claims, nil
}

// fetchUserInfo calls the IdP's /oauth2/userinfo endpoint with the access token.
func (h *H) fetchUserInfo(accessToken string) (*oauthClaims, error) {
	userInfoURL := h.oauthSettings.Issuer + "/oauth2/userinfo"

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, userInfoURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := http.DefaultClient.Do(req)
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

// parseJWTClaimsUnsafe extracts claims from a JWT without verifying the signature.
// Used only as a fallback when userinfo is unavailable.
func (h *H) parseJWTClaimsUnsafe(token string) (*oauthClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid JWT structure")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("decode JWT payload: %w", err)
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal JWT payload: %w", err)
	}
	return h.mapClaims(raw)
}

// mapClaims converts a raw claims map to oauthClaims using the configured field names.
func (h *H) mapClaims(raw map[string]interface{}) (*oauthClaims, error) {
	claimSub, claimEmail, claimUsername, claimName := h.oauthSettings.EffectiveClaimNames()

	strClaim := func(key string) string {
		if v, ok := raw[key]; ok {
			if s, ok := v.(string); ok {
				return strings.TrimSpace(s)
			}
		}
		return ""
	}

	c := &oauthClaims{
		Sub:         strClaim(claimSub),
		Email:       strClaim(claimEmail),
		Username:    strClaim(claimUsername),
		DisplayName: strClaim(claimName),
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
		u.Email = claims.Email
		u.UpdatedAt = timeNow()
		if err := h.db.Users.Save(u); err != nil {
			return nil, err
		}
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

	claimSub, claimEmail, claimUsername, claimName := s.EffectiveClaimNames()
	updates := map[string]string{
		"oauth_enabled":        boolStr(s.Enabled),
		"oauth_issuer":         s.Issuer,
		"oauth_client_id":      s.ClientID,
		"oauth_redirect_uri":   s.RedirectURI,
		"oauth_scope":          s.Scope,
		"oauth_claim_sub":      claimSub,
		"oauth_claim_email":    claimEmail,
		"oauth_claim_username": claimUsername,
		"oauth_claim_name":     claimName,
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
