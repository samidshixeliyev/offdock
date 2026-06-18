package deploy

import (
	"gopkg.in/yaml.v3"
)

// injectNetworkConfig adds dns / dns_search / extra_hosts to every service in a
// compose document. The raw YAML stored in the DB is never modified; this is
// applied only to the file written to disk at deploy time, so the source of
// truth stays clean. If nothing needs injecting, raw is returned unchanged.
//
// On any parse error the original raw is returned (never break a deploy over a
// transform), with the error surfaced to the caller for logging.
func injectNetworkConfig(raw string, dns, dnsSearch, extraHosts []string) (string, error) {
	return applyComposeOverrides(raw, dns, dnsSearch, extraHosts, nil)
}

// applyComposeOverrides applies network config and per-service image overrides to
// a compose document. imageOverrides maps a service name to a full image
// reference (repo:tag) that replaces the service's `image:` — this is how
// "deploy a previously-loaded image" works (e.g. roll an app back to myapp:1.2).
// The raw YAML in the DB is never changed; this only affects the deploy-time file.
func applyComposeOverrides(raw string, dns, dnsSearch, extraHosts []string, imageOverrides map[string]string) (string, error) {
	if len(dns) == 0 && len(dnsSearch) == 0 && len(extraHosts) == 0 && len(imageOverrides) == 0 {
		return raw, nil
	}

	var doc map[string]any
	if err := yaml.Unmarshal([]byte(raw), &doc); err != nil {
		return raw, err
	}
	if doc == nil {
		return raw, nil
	}

	servicesRaw, ok := doc["services"]
	if !ok {
		return raw, nil
	}
	services, ok := servicesRaw.(map[string]any)
	if !ok {
		return raw, nil
	}

	for name, svcRaw := range services {
		svc, ok := svcRaw.(map[string]any)
		if !ok {
			// A service written with an empty/nil body (e.g. `web:` with no
			// fields) unmarshals to nil. If we have something to inject for it
			// (notably an image override), start a fresh map rather than silently
			// dropping the override.
			if svcRaw == nil && (len(dns) > 0 || len(dnsSearch) > 0 || len(extraHosts) > 0 || imageOverrides[name] != "") {
				svc = map[string]any{}
			} else {
				continue
			}
		}
		if len(dns) > 0 {
			svc["dns"] = toAnySlice(dns)
		}
		if len(dnsSearch) > 0 {
			svc["dns_search"] = toAnySlice(dnsSearch)
		}
		if len(extraHosts) > 0 {
			svc["extra_hosts"] = mergeStringList(svc["extra_hosts"], extraHosts)
		}
		if ref, ok := imageOverrides[name]; ok && ref != "" {
			svc["image"] = ref
		}
		services[name] = svc
	}
	doc["services"] = services

	out, err := yaml.Marshal(doc)
	if err != nil {
		return raw, err
	}
	return string(out), nil
}

func toAnySlice(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

// mergeStringList appends add entries to an existing compose list value
// (which may be a []any of strings), de-duplicating.
func mergeStringList(existing any, add []string) []any {
	seen := map[string]bool{}
	var out []any
	if cur, ok := existing.([]any); ok {
		for _, v := range cur {
			if s, ok := v.(string); ok {
				if !seen[s] {
					seen[s] = true
					out = append(out, s)
				}
			}
		}
	}
	for _, s := range add {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
