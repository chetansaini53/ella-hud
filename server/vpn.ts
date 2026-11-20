import os from "node:os";

const VPN_ADAPTER = /vpn|wireguard|^wg\d|^tun|^tap|tailscale|zerotier|nord|proton|openvpn|warp|fortinet|anyconnect|globalprotect/i;

/** Best-effort: true when a known VPN/tunnel adapter has a routable IPv4 (169.254.x = adapter present but disconnected). */
export function vpnActive(): boolean {
  return Object.entries(os.networkInterfaces()).some(
    ([name, addrs]) => VPN_ADAPTER.test(name) && (addrs ?? []).some((a) => a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")),
  );
}
