import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { GarageDoorOpenerAccessory } from './platformAccessory.js';
import { GarageMQTT } from './garageclient.js';
import { HCPDiscovery, defaultDiscovery } from './discovery.js';

interface HADiscoveryPayload {
  name?: string;
  state_topic?: string;
  command_topic?: string;
  payload_open?: string;
  payload_close?: string;
  payload_stop?: string;
  payload_on?: string;
  payload_off?: string;
  availability_topic?: string;
  payload_available?: string;
  payload_not_available?: string;
  device?: {
    manufacturer?: string;
    model?: string;
    sw_version?: string;
    configuration_url?: string;
  };
}

interface HAStatePayload {
  valid: boolean;
  doorstate: string;
  detailedState: string;
  lamp: string;
}

export class GarageDoorOpenerPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private garageAccessory: GarageDoorOpenerAccessory | null;
  private garageClient: GarageMQTT;
  private isOnline = false;
  private isVenting = false;
  private currentDetailedState = '';
  public discovery: HCPDiscovery = { ...defaultDiscovery };

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.garageAccessory = null;
    this.garageClient = new GarageMQTT(null, log);
    this.log.debug('Finished initializing platform:', this.config.name);

    if (!log.success) {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      log.success = log.info;
    }

    this.api.on('didFinishLaunching', () => {
      void this.initialize();
    });
  }

  async initialize() {
    this.log.debug('initializing...');
    await this.connectMQTTClient();
    this.log.debug('connected to client: ', this.garageClient.getClient());
    await this.loadDiscovery();
    this.initializeAccessory();
    void this.mqttSubscription();
  }

  async loadDiscovery(): Promise<void> {
    // Use configured hostname if provided, otherwise auto-discover via wildcard
    const configHostname = this.config['hcpHostname'] as string | null;

    const discoveryTopics = configHostname
      ? [
        `homeassistant/cover/${configHostname}/door/config`,
        `homeassistant/switch/${configHostname}/lamp/config`,
        `homeassistant/switch/${configHostname}/vent/config`,
      ]
      : ['homeassistant/+/+/+/config'];

    await this.garageClient.addSubscription(discoveryTopics);

    return new Promise((resolve) => {
      let done = false;
      let doorReceived = false;
      let lampReceived = false;
      let ventReceived = false;

      const tryResolve = () => {
        if (done || !doorReceived) {
          return;
        }
        done = true;
        this.log.info(
          `Discovery complete — hostname: ${this.discovery.hostname}` +
          ` | IP: ${this.discovery.ipAddress || 'unknown'}` +
          ` | firmware: ${this.discovery.swVersion}` +
          ` | lamp: ${this.discovery.lampDiscovered ? 'yes' : 'no'}` +
          ` | vent: ${this.discovery.ventDiscovered ? 'yes' : 'no'}`,
        );
        resolve();
      };

      const timeout = setTimeout(() => {
        if (!done) {
          done = true;
          this.log.warn(
            'Discovery timeout — using default config' +
            (doorReceived ? ' (partial)' : ' (no device found)'),
          );
          resolve();
        }
      }, 5000);

      this.garageClient.onMessage((topic, payload) => {
        if (done) {
          return;
        }
        if (!topic.endsWith('/config')) {
          return;
        }

        try {
          const json = JSON.parse(payload.toString('utf8')) as HADiscoveryPayload;

          if (topic.includes('/door/')) {
            // Extract hostname from topic: homeassistant/cover/{hostname}/door/config
            const parts = topic.split('/');
            if (parts.length >= 3) {
              this.discovery.hostname = parts[2];
            }
            this.discovery.doorStateTopic = json.state_topic ?? this.discovery.doorStateTopic;
            this.discovery.doorCommandTopic = json.command_topic ?? this.discovery.doorCommandTopic;
            this.discovery.doorPayloadOpen = json.payload_open ?? this.discovery.doorPayloadOpen;
            this.discovery.doorPayloadClose = json.payload_close ?? this.discovery.doorPayloadClose;
            this.discovery.doorPayloadStop = json.payload_stop ?? this.discovery.doorPayloadStop;
            if (json.device) {
              this.discovery.manufacturer = json.device.manufacturer ?? this.discovery.manufacturer;
              this.discovery.model = json.device.model ?? this.discovery.model;
              this.discovery.swVersion = json.device.sw_version ?? this.discovery.swVersion;
              if (json.device.configuration_url) {
                // extract IP from "http://192.168.x.x" or "http://hostname"
                const match = json.device.configuration_url.match(/https?:\/\/([^/]+)/);
                this.discovery.ipAddress = match ? match[1] : '';
              }
            }
            if (json.availability_topic) {
              this.discovery.availabilityTopic = json.availability_topic;
              this.discovery.payloadAvailable = json.payload_available ?? 'online';
              this.discovery.payloadNotAvailable = json.payload_not_available ?? 'offline';
            }
            doorReceived = true;
            clearTimeout(timeout);
            // If hostname was auto-discovered, lamp/vent may arrive soon — give them 500ms
            setTimeout(tryResolve, 500);
          }

          if (topic.includes('/lamp/')) {
            this.discovery.lampCommandTopic = json.command_topic ?? this.discovery.lampCommandTopic;
            this.discovery.lampPayloadOn = json.payload_on ?? this.discovery.lampPayloadOn;
            this.discovery.lampPayloadOff = json.payload_off ?? this.discovery.lampPayloadOff;
            this.discovery.lampDiscovered = true;
            lampReceived = true;
          }

          if (topic.includes('/vent/')) {
            this.discovery.ventCommandTopic = json.command_topic ?? this.discovery.ventCommandTopic;
            this.discovery.ventPayloadOn = json.payload_on ?? this.discovery.ventPayloadOn;
            this.discovery.ventPayloadOff = json.payload_off ?? this.discovery.ventPayloadOff;
            this.discovery.ventDiscovered = true;
            ventReceived = true;
          }

          // Resolve immediately once all three are received
          if (doorReceived && lampReceived && ventReceived) {
            clearTimeout(timeout);
            tryResolve();
          }

        } catch (e) {
          this.log.warn('Failed to parse discovery payload for topic: ', topic);
        }
      });
    });
  }

  async cleanup() {
    await this.garageClient?.disconnect();
  }

  // Lamp is enabled if discovered (unless explicitly disabled in config)
  isLampEnabled(): boolean {
    const override = this.config['enableLamp'] as boolean | undefined;
    if (override === false) {
      return false;
    }
    return this.discovery.lampDiscovered || (override === true);
  }

  // Vent is enabled if discovered (unless explicitly disabled in config)
  isVentEnabled(): boolean {
    const override = this.config['enableVent'] as boolean | undefined;
    if (override === false) {
      return false;
    }
    return this.discovery.ventDiscovered || (override === true);
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.debug('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async connectMQTTClient(): Promise<void> {
    this.log.debug('discovering GarageMQTT client...');
    const mqttUsername = this.config['mqttUsername'] as string;
    const mqttPassword = this.config['mqttPassword'] as string;
    const clientID = this.config['mqttClientID'] as string | null ?? 'GarageDoorMQTT';
    const mqttHost = this.config['mqttHost'] as string | null ?? 'mqtt://localhost:1883';
    await this.garageClient?.connectAsync(clientID, mqttUsername, mqttPassword, mqttHost);
  }

  async mqttSubscription(): Promise<void> {
    const subscription = await this.garageClient.addSubscription([
      this.discovery.doorStateTopic,
      this.discovery.doorCommandTopic,
      this.discovery.availabilityTopic,
    ]);
    this.log.debug('mqtt subscriptions: ', subscription);
    this.garageClient.onMessage(this.receiveMessage.bind(this));
  }

  receiveMessage(topic: string, payload: Buffer) {
    const stringValue = payload.toString('utf8');
    this.log.debug('received topic: ', topic, 'payload: ', stringValue);

    switch (topic) {
      case this.discovery.doorStateTopic:
        this.handleStateMessage(stringValue);
        break;

      case this.discovery.doorCommandTopic:
        this.handleCommandMessage(stringValue);
        break;

      case this.discovery.availabilityTopic:
        this.isOnline = stringValue === this.discovery.payloadAvailable;
        this.log.info('Device availability:', stringValue);
        break;

      default:
        this.log.debug('unhandled topic message: ', topic);
        break;
    }
  }

  private handleStateMessage(stringValue: string) {
    let stateString = stringValue;
    try {
      const json = JSON.parse(stringValue) as HAStatePayload;
      if (json.valid === true && typeof json.doorstate === 'string') {
        stateString = json.doorstate;

        if (typeof json.detailedState === 'string') {
          this.currentDetailedState = json.detailedState;
          const venting = json.detailedState === 'venting';
          if (venting !== this.isVenting) {
            this.isVenting = venting;
            this.garageAccessory?.updateVentState(venting);
          }
        }

        if (typeof json.lamp === 'string') {
          this.garageAccessory?.updateLampState(json.lamp === this.discovery.lampPayloadOn);
        }

        if (json.detailedState === 'stopped') {
          this.log.info('Door stopped');
          this.garageAccessory?.updateTargetDoorStateWithoutPublishing(
            this.Characteristic.TargetDoorState.OPEN,
          );
        }
      } else {
        this.log.warn('State topic: invalid or missing doorstate in payload: ', stringValue);
        return;
      }
    } catch (e) {
      this.log.warn('State topic: failed to parse JSON payload: ', stringValue);
      return;
    }

    const value = this.mapCurrentDoorState(stateString);
    if (value >= 0) {
      this.garageAccessory?.updateCurrentDoorState(value);
      this.log.debug('did update current state to: ', value);
      // Sync target to match stable AND transitional states
      // This prevents HomeKit showing wrong direction during movement
      const targetValue = this.mapStateToTarget(stateString);
      if (targetValue >= 0) {
        this.garageAccessory?.updateTargetDoorStateWithoutPublishing(targetValue);
      }
    } else {
      this.log.error('State topic: unknown door state value ', value, ' for payload: ', stateString);
    }
  }

  private mapStateToTarget(stateString: string): number {
    switch (stateString) {
      case 'open':
      case 'opening':
      case 'opening v':
      case 'opening h':
      case 'stopped':
      case 'venting': return this.Characteristic.TargetDoorState.OPEN;
      case 'closed':
      case 'closing': return this.Characteristic.TargetDoorState.CLOSED;
      default: return -1;
    }
  }

  private handleCommandMessage(stringValue: string) {
    const value = this.mapTargetDoorState(stringValue);
    if (value > -1) {
      this.garageAccessory?.updateTargetDoorStateWithoutPublishing(value);
      this.log.debug('did update target state to:', value);
    } else {
      this.log.error('Command topic: unknown door state value ', value, ' for payload: ', stringValue);
    }
  }

  getIsOnline(): boolean {
    return this.isOnline;
  }

  getCurrentDetailedState(): string {
    return this.currentDetailedState;
  }

  isCurrentlyVenting(): boolean {
    return this.isVenting;
  }

  initializeAccessory() {
    if (this.garageAccessory !== null) {
      this.log.debug('Accessory already initialized');
      return;
    }

    this.log.debug('initializing Garage Door Opener Accessory...');

    const deviceID = 'GDC01';
    const deviceDisplayName = (this.config['displayName'] as string) ?? 'Garage Door';
    const uuid = this.api.hap.uuid.generate(deviceID);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.debug('Restoring existing accessory from cache:', existingAccessory.displayName);
      this.garageAccessory = new GarageDoorOpenerAccessory(this, existingAccessory);
    } else {
      this.log.debug('Adding new accessory:', deviceDisplayName);
      const accessory = new this.api.platformAccessory(deviceDisplayName, uuid);
      this.garageAccessory = new GarageDoorOpenerAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  mapCurrentDoorState(value: string): number {
    switch (value) {
      case 'open': return this.Characteristic.CurrentDoorState.OPEN;
      case 'closed': return this.Characteristic.CurrentDoorState.CLOSED;
      case 'opening': return this.Characteristic.CurrentDoorState.OPENING;
      case 'opening v': return this.Characteristic.CurrentDoorState.OPENING;
      case 'opening h': return this.Characteristic.CurrentDoorState.OPENING;
      case 'closing': return this.Characteristic.CurrentDoorState.CLOSING;
      case 'stopped': return this.Characteristic.CurrentDoorState.STOPPED;
      case 'stop': return this.Characteristic.CurrentDoorState.STOPPED;
      case 'venting': return this.Characteristic.CurrentDoorState.STOPPED;
      default: return -1;
    }
  }

  mapTargetDoorState(value: string): number {
    switch (value) {
      case 'open': return this.Characteristic.TargetDoorState.OPEN;
      case 'close':
      case 'closed': return this.Characteristic.TargetDoorState.CLOSED;
      case 'venting':
      case 'vent': return this.Characteristic.TargetDoorState.OPEN;
      case 'stop': return this.Characteristic.TargetDoorState.OPEN;
      default: return -1;
    }
  }

  publishTargetDoorState(value: number) {
    const payload = value === this.Characteristic.TargetDoorState.OPEN
      ? this.discovery.doorPayloadOpen
      : this.discovery.doorPayloadClose;
    this.log.debug('publishing target door state: ', payload, ' to topic: ', this.discovery.doorCommandTopic);
    this.garageClient?.publishValue(this.discovery.doorCommandTopic, payload);
  }

  publishStopCommand() {
    this.log.debug('publishing stop command to topic: ', this.discovery.doorCommandTopic);
    this.garageClient?.publishValue(this.discovery.doorCommandTopic, this.discovery.doorPayloadStop);
  }

  publishLampCommand(value: boolean) {
    const payload = value ? this.discovery.lampPayloadOn : this.discovery.lampPayloadOff;
    this.log.debug('publishing lamp command: ', payload, ' to topic: ', this.discovery.lampCommandTopic);
    this.garageClient?.publishValue(this.discovery.lampCommandTopic, payload);
  }

  publishVentCommand() {
    this.log.debug('publishing vent on command to topic: ', this.discovery.ventCommandTopic);
    this.garageClient?.publishValue(this.discovery.ventCommandTopic, this.discovery.ventPayloadOn);
  }

  publishVentOffCommand() {
    this.log.debug('publishing vent off command to topic: ', this.discovery.ventCommandTopic);
    this.garageClient?.publishValue(this.discovery.ventCommandTopic, this.discovery.ventPayloadOff);
  }
}
