/**
 * In-memory stand-in for the server's key directory.
 *
 * Models the thing that actually matters for multi-device: a *user* has many devices,
 * and claiming a bundle claims one per device.
 */
import type { EncodedDeviceBundles, EncodedPreKeyBundle, PublishablePreKeys } from '../session';

type StoredDevice = {
  deviceRowId: string;
  deviceId: string;
  identityKey: string;
  signedPreKey: { keyId: string; publicKey: string; signature: string };
  oneTimePreKeys: { keyId: string; publicKey: string }[];
};

export class Directory {
  private readonly devices = new Map<string, StoredDevice[]>();

  claims = 0;

  /** Register or update one device's key material. */
  publish(userId: string, keys: PublishablePreKeys): string {
    const existing = this.devices.get(userId) ?? [];
    const found = existing.find((device) => device.deviceId === keys.deviceId);

    if (found) {
      found.identityKey = keys.identityKey;
      found.signedPreKey = keys.signedPreKey;
      if (keys.oneTimePreKeys.length > 0) {
        found.oneTimePreKeys = [...keys.oneTimePreKeys];
      }
      return found.deviceRowId;
    }

    const device: StoredDevice = {
      deviceRowId: 'row-' + userId + '-' + (existing.length + 1),
      deviceId: keys.deviceId,
      identityKey: keys.identityKey,
      signedPreKey: keys.signedPreKey,
      oneTimePreKeys: [...keys.oneTimePreKeys],
    };
    this.devices.set(userId, [...existing, device]);
    return device.deviceRowId;
  }

  addOneTimePreKeys(
    userId: string,
    deviceId: string,
    preKeys: { keyId: string; publicKey: string }[],
  ): void {
    const device = (this.devices.get(userId) ?? []).find(
      (candidate) => candidate.deviceId === deviceId,
    );
    device?.oneTimePreKeys.push(...preKeys);
  }

  /** Claim one prekey from every device the user has. */
  async claim(userId: string): Promise<EncodedDeviceBundles> {
    const devices = this.devices.get(userId);
    if (!devices || devices.length === 0) {
      throw new Error('No devices published for ' + userId);
    }
    this.claims += 1;

    const bundles: EncodedPreKeyBundle[] = devices.map((device) => {
      // Consumed exactly as the server does it.
      const oneTimePreKey = device.oneTimePreKeys.shift() ?? null;
      return {
        device_row_id: device.deviceRowId,
        device_id: device.deviceId,
        identity_key: device.identityKey,
        identity_key_changed_at: null,
        signed_prekey_id: device.signedPreKey.keyId,
        signed_prekey: device.signedPreKey.publicKey,
        signed_prekey_signature: device.signedPreKey.signature,
        one_time_prekey_id: oneTimePreKey ? oneTimePreKey.keyId : null,
        one_time_prekey: oneTimePreKey ? oneTimePreKey.publicKey : null,
      };
    });

    return { user_id: userId, devices: bundles };
  }

  deviceRowIds(userId: string): string[] {
    return (this.devices.get(userId) ?? []).map((device) => device.deviceRowId);
  }

  /** Drain a device's pool, to exercise the no-OPK path. */
  exhaustOneTimePreKeys(userId: string): void {
    (this.devices.get(userId) ?? []).forEach((device) => {
      device.oneTimePreKeys = [];
    });
  }
}
