# TP-Link KASA LAN for Homey

## This fork: 0.4.3

This fork is maintained at https://github.com/metalcated/nu.baretta.tplink and starts from the community app's `sdk3` branch, version 0.3.11. It retains the `nu.baretta.tplink` app identity and all existing model drivers so updating the community app preserves its paired devices and app data. The original authors and license are retained.

Choose **Add device → TP-Link KASA LAN → Scan all Kasa devices**. One scan lists supported bulbs, switches, dimmers and plugs together. Each power-strip outlet and supported fan/light channel is a separate choice. Use **Select all available** or select individual devices, then **Add selected**. Already-paired LAN devices are excluded from creation. If an add fails partway through, successful devices stay added and only the remaining selection is retried.

The scanner reports missing accounts, rejected authentication and unsupported models instead of treating them as absent. Newer encrypted devices use the account saved in this app's Settings or the complete account supplied during pairing. A TCP-only selection does not save unused credentials. Unknown firmware is not assumed compatible just because its product name is similar.

If broadcasts cannot cross your network, open the app’s **Settings → Discovery networks**, enter the exact private network (for example `192.168.181.0/24`) and choose **Save discovery networks**. This setting is saved in Homey’s database and is used by subsequent combined scans. The pairing view also accepts one-off network or individual-IP overrides. A device address is never used to guess the subnet.

CIDR discovery sends directed UDP probes to usable hosts, then performs local validation only for devices that reply. It does not run a TCP sweep across the subnet. Individual IPs additionally receive a direct-read fallback when UDP replies are blocked. Targets are deduplicated and bounded to 1,024 addresses in RFC1918 networks with prefixes `/22` through `/32`; up to 64 individual IPs may also be entered. Scans have bounded verification concurrency and a 25-second overall limit. Routed networks still require Homey to have access to the device ports; this app does not change routers, VLANs or firewall rules.

Added models:

- **KL135:** on/off, brightness, hue, saturation, colour temperature, colour/temperature modes and actual power measurement. Known IOT firmware is supported; SMART bulb firmware remains explicitly unsupported by the bundled API.
- **KS200:** on/off and status LED, including validated TCP and authenticated local connections. This is a separate model from KS200M and does not claim motion or ambient-light sensors.

The fork also corrects manual-IP discovery arguments in KP400, KP303, KP200, HS300 and EP40. Bulk pairing keeps the validated physical identity, outlet/channel identity and working local transport. It verifies selected devices again before saving an account or returning creation data.

### Build and install

Build and tests run entirely in Docker; do not install dependencies on the host:

```bash
docker build --tag metalcated/homey-kasa-lan-installer:0.4.3 /Users/mgomon/Code/homey/nu.baretta.tplink
```

After approving an update to the running Homey, use the established installer route:

```bash
bash /Users/mgomon/Code/homey/nu.baretta.tplink/scripts/install.sh --via-foreman
```

`HOMEY_AUTH_VOLUME` defaults to `homey-lennox-cli-auth`; set it explicitly to use another existing CLI account volume. `HOMEY_ID`, `HOMEY_INSTALLER_IMAGE`, `HOMEY_SSH_JUMP`, `HOMEY_SSH_TARGET` and `HOMEY_TUNNEL_PORT` are optional environment overrides. The installer verifies the selected Homey's identity before using its login and uploads with `clean:false`. It checks the exact installed app ID, version and running state; an old running app cannot conceal a failed upload.

Installation updates the community app only. Devices and Flows belonging to the official `com.tplink.kasa` app do not automatically transfer: add the LAN counterparts, compare their controls and state, then deliberately update dependent Flows and dashboards. Keep the official devices until that migration has been verified. Do not delete devices to troubleshoot discovery.

The Settings page uses a responsive layout with full-width discovery fields, a visible account-status/test section, optional account editing and collapsed advanced tools. Errors and account-clear confirmation stay inside the page; they do not invoke browser alerts or prompts.

The combined scanner uses its own row class and opts out of Homey's legacy control styling. Device names and model/IP details wrap to their full height in the actual pairing modal, including narrow screens.

### Validation and physical acceptance

Automated tests cover mixed-model scans, separate outlets, model/physical-ID checks, encrypted transport preservation, rejected accounts, duplicate suppression, rescan/cancel/disconnect races, bounded verification, partial-add retries, offline recovery, settings edits and existing Flow behavior. Loopback UDP/TCP/XOR emulators exercise the bundled API's actual network protocol for KP400 discovery plus KL135 and KS200 controls. These emulators do not establish physical-device or Homey mobile-client acceptance.

Before calling the installation complete, test one real device of each installed model: scan and manual IP, initial state, each supported control, external state updates, app restart/reconnect, account rejection/recovery, individual outlet identity, and affected Flows. Record the hardware and firmware versions. Read-only discovery and status reads come first; perform physical switching or lighting tests only with approval. Restore the prior community release before pairing new generic devices if an immediate code rollback is needed; an older release does not understand the new generic driver. No automatic migration or deletion is performed.

## Upstream application

TP-Link KASA LAN connects supported TP-Link Kasa plugs, outlets, power strips, wall switches, dimmers, bulbs, and light strips to Homey Pro. Communication and everyday control take place over the local network, so supported devices can be used from the Homey app and in Flows without relying on cloud control for each command.

The app supports automatic LAN discovery, manual-IP pairing, recovery after an IP-address change, device controls, status polling, lighting controls, energy measurements on compatible models, and model-specific Flow actions.

## Requirements

- Homey Pro running Homey software 5.0.0 or newer.
- A supported TP-Link device reachable from Homey on the local network.
- TP-Link account credentials for authenticated SMART models such as KS225, S500D, and KS240. Configure a default account once in the app Settings page; it authenticates encrypted local connections and is never written to application logs. A device can retain a separate Advanced Settings override for a different account.
- Third-Party Compatibility enabled in the Kasa app when required by a legacy Kasa device or firmware version.

## Supported devices

Features vary by model and hardware or firmware revision.

| Category | Models | Main Homey features |
| --- | --- | --- |
| Plugs and outlets | HS100, HS103, HS105, HS110, EP10, EP25, KP105, KP115, KP200, KP303 | On/off, LED control, and energy measurements on supported models |
| Two-outlet plug | HS107 | Two separately paired outlets, local LAN on/off, and one shared parent-level LED; no energy monitoring or account credentials |
| Power strips and outdoor outlets | HS300, EP40, KP400 | Separately paired outlets where supported, on/off, LED control, and energy measurements on supported models |
| Dimmable outdoor plug | KP405 | On/off, dimming, and LED control |
| Wall switches and dimmers | ES20M, HS200, HS210, HS220, KS225, KS230, S500D | On/off, dimming where supported, LED control, and model-specific measurements |
| Motion and ambient-light switch | KS200M | On/off, LED control, motion alarm, and ambient-light measurement |
| Fan and light controller | KS240 | Fan and light channels paired as separate Homey devices, with on/off and level control |
| Bulbs | LB100, LB110, LB120, LB130, KL50, KL60, KL110, KL120, KL125, KL130 | On/off, dimming, color temperature, color, and lighting modes where supported |
| Light strips | KL400, KL430 | On/off, dimming, color temperature, color, and lighting modes |

The driver list represents the models recognized by the current app manifest. Similar-looking regional variants are not automatically supported unless their model identifier matches one of the listed drivers.

## Authenticated SMART devices

Newer TP-Link devices no longer accept the original unencrypted Kasa protocol. The app includes authenticated local support for:

- KS225 using the KLAP transport.
- S500D using the AES transport.
- KS240 using the AES transport, including separate fan and light child devices.

Configure the default TP-Link account once from the app Settings page. New KS225, S500D, and KS240 devices use that global source without copying its password into every paired device. If no default exists, the first successfully authenticated pairing can create it only after the selected physical device has accepted the credentials.

For a second TP-Link account, enter a different complete account pair during pairing or in that device's Advanced Settings. This creates a device-only override. Clearing both local credential fields explicitly returns the device to the global source. Existing devices without a source marker retain a complete legacy local pair before falling back to a complete global pair; use the Settings page's adoption action to convert matching legacy copies deliberately.

This support has passed API fixtures, automated tests, dependency checks, and Homey package validation. Physical testing across the different hardware and firmware revisions still depends on feedback from device owners, so these drivers should be treated as community-tested until more real-device results are available.

## Pairing

1. Ensure Homey and the TP-Link device can reach each other on the local network.
2. In Homey, add a device and select the driver matching the exact model.
3. Try automatic discovery first.
4. If discovery is blocked by a VLAN, Wi-Fi isolation, firewall, or router configuration, enter the device IP address manually.
5. For KS225, S500D, or KS240, use the configured default TP-Link account or provide a complete account pair. A different complete pair becomes a device-only override. Pairing validates the selected physical target before it is saved.
6. Select all discovered devices or channels that you want to add.

HS107 discovery presents both physical outlets as separate Homey socket devices. They share the unit's parent-level status LED and use credential-free local Kasa LAN control; HS107 does not provide energy measurements.

EP10 devices that use the original TCP transport can pair without credentials. Authenticated KLAP or AES EP10 firmware requires a complete account pair; a TCP pairing never stores or creates a global account from unused credentials.

Reserving an IP address in the router's DHCP configuration is recommended. If that is not possible, enable the dynamic-IP option in the device settings so the app can attempt rediscovery when the address changes.

## Homey capabilities and Flows

Depending on the device, the app exposes:

- On/off and toggle control.
- Dimming, color, saturation, and color-temperature control.
- Circadian and normal lighting modes.
- LED or night-mode control.
- Power, current, voltage, and accumulated-energy measurements.
- Motion and ambient-light information for KS200M.
- Power-meter reset and undo actions.
- Transition-based bulb on/off actions.

Standard Homey capability triggers and conditions remain available for compatible devices. Existing driver IDs, capability IDs, paired-device identities, and Flow contracts are preserved by the authenticated-device update.

## Troubleshooting and diagnostic reports

If a device stops responding after an update, do not remove it immediately because removing it can affect existing Flows.

1. Confirm that the device still works in the Kasa app and is online on the same local network as Homey.
2. For a legacy Kasa device, verify that Third-Party Compatibility is still enabled in the Kasa app.
3. Check the stored IP address and try manual-IP pairing or the dynamic-IP option when discovery cannot reach the device.
4. For KS225, S500D, KS240, or authenticated EP10 firmware, verify the default account in the app Settings page. Check a device's Advanced Settings only when it intentionally uses a different-account override or an unadopted legacy pair.
5. Restart the TP-Link KASA LAN app once, reproduce the problem, and create a Homey app diagnostic report as soon as possible.

When reporting a problem, include the diagnostic-report ID, exact TP-Link model, hardware and firmware version, Homey model and firmware version, app version, whether the device was newly paired or already installed, the pairing method, the failed action, and the approximate time of the failure.

Never publish TP-Link or Homey credentials, access tokens, public IP addresses, or remote-access details. Use a private message only when additional coordination is necessary.

## Community testing and contributions

Reports from owners of KS225, S500D, KS240, ES20M, HS110, HS220, and KS230 devices are especially helpful. Please test pairing, controls, status updates, app restart recovery, and existing Flows. Both successful results and failures accompanied by a diagnostic-report ID help improve compatibility.

Source code and issue tracking:

- Homey app: https://github.com/shaarkys/nu.baretta.tplink
- TP-Link API fork: https://github.com/shaarkys/tplink-smarthome-api
- Homey community discussion: https://community.homey.app/t/app-pro-tp-link-kasa-lan-smart-plugs-and-bulbs-wifi/1045

The app uses a maintained fork of Patrick Seal's `tplink-smarthome-api` and builds on earlier TP-Link protocol research by the open-source community. This is a community integration and is not affiliated with or endorsed by TP-Link or Athom.
