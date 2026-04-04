import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { GarageDoorOpenerAccessory } from './platformAccessory.js';
import { GarageMQTT } from './garageclient.js';

export class GarageDoorOpenerPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private garageAccessory: GarageDoorOpenerAccessory | null;
  private garageClient: GarageMQTT;
  private isOnline = false; // start offline until confirmed
  private isVenting = false;
  private currentDetailedState = '';
  private discovery: HCPDiscovery = { ...defaultDiscovery };
  private discoveryComplete = false;
  
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
    const topics = [
      'homeassistant/cover/hcpbridge/door/config',
      'homeassistant/switch/hcpbridge/lamp/config',
      'homeassistant/switch/hcpbridge/vent/config',
    ];

    return new Promise((resolve) => {
      let received = 0;
      const timeout = setTimeout(() => {
        this.log.warn('Discovery timeout — using default topic config');
        resolve();
      }, 5000); // wait max 5 seconds for retained messages

      this.garageClient.addSubscription(topics).then(() => {
        this.garageClient.onMessage((topic, payload) => {
          try {
            const json = JSON.parse(payload.toString('ascii'));

            if (topic.includes('/door/')) {
              this.discovery.doorStateTopic    = json.state_topic    ?? this.discovery.doorStateTopic;
              this.discovery.doorCommandTopic  = json.command_topic  ?? this.discovery.doorCommandTopic;
              this.discovery.doorPayloadOpen   = json.payload_open   ?? this.discovery.doorPayloadOpen;
              this.discovery.doorPayloadClose  = json.payload_close  ?? this.discovery.doorPayloadClose;
              this.discovery.doorPayloadStop   = json.payload_stop   ?? this.discovery.doorPayloadStop;
              // device info
              if (json.device) {
                this.discovery.manufacturer = json.device.manufacturer ?? this.discovery.manufacturer;
                this.discovery.model        = json.device.model        ?? this.discovery.model;
                this.discovery.swVersion    = json.device.sw_version   ?? this.discovery.swVersion;
              }
              if (json.availability_topic) {
                this.discovery.availabilityTopic   = json.availability_topic;
                this.discovery.payloadAvailable    = json.payload_available    ?? 'online';
                this.discovery.payloadNotAvailable = json.payload_not_available ?? 'offline';
              }
            }

            if (topic.includes('/lamp/')) {
              this.discovery.lampCommandTopic = json.command_topic ?? this.discovery.lampCommandTopic;
              this.discovery.lampPayloadOn    = json.payload_on    ?? this.discovery.lampPayloadOn;
              this.discovery.lampPayloadOff   = json.payload_off   ?? this.discovery.lampPayloadOff;
            }

            if (topic.includes('/vent/')) {
              this.discovery.ventCommandTopic = json.command_topic ?? this.discovery.ventCommandTopic;
              this.discovery.ventPayloadOn    = json.payload_on    ?? this.discovery.ventPayloadOn;
              this.discovery.ventPayloadOff   = json.payload_off   ?? this.discovery.ventPayloadOff;
            }

          } catch (e) {
            this.log.warn('Failed to parse discovery payload for topic: ', topic);
          }

          received++;
          if (received >= topics.length) {
            clearTimeout(timeout);
            this.discoveryComplete = true;
            this.log.info('Discovery complete — firmware v' + this.discovery.swVersion);
            // unsubscribe from discovery topics — no longer needed
            void this.garageClient.removeSubscription(topics);
            resolve();
          }
        });
      });
    });
  }
  
  isLampEnabled(): boolean {
    return (this.config['enableLamp'] as boolean) ?? false;
  }
  
  getLampCommandTopic(): string {
    return (this.config['lampCommandTopic'] as string) ?? 'hormann/hcpbridge/command/lamp';
  }
  
  publishLampCommand(value: boolean) {
    const payload = value ? 'true' : 'false';
    this.log.debug('publishing lamp command: ', payload, ' to topic: ', this.getLampCommandTopic());
    this.garageClient?.publishValue(this.getLampCommandTopic(), payload);
  }
  
  isVentEnabled(): boolean {
    return (this.config['enableVent'] as boolean) ?? false;
  }

  getMqttVentMessage(): string {
    return (this.config['mqttVentMessage'] as string) ?? 'vent';
  }

  publishVentCommand() {
    this.log.debug('publishing vent command to topic: ', this.getTargetTopic());
    this.garageClient?.publishValue(this.getTargetTopic(), this.getMqttVentMessage());
  }
  
  getAvailabilityTopic(): string {
    return (this.config['availabilityTopic'] as string) ?? 'hormann/hcpbridge/availability';
  }
  
  async cleanup() {
    await this.garageClient?.disconnect();
  }

  getTargetTopic(): string {
    return (this.config['targetTopic'] as string) ?? 'garage/door/target';
  }

  getCurrentTopic(): string {
    return (this.config['currentTopic'] as string) ?? 'garage/door/current';
  }

  geLogTopic(): string {
    return (this.config['stateTopic'] as string) ?? 'garage/door/log';
  }

  getCurrentDoorStateClosed(): number {
    return this.Characteristic.CurrentDoorState.CLOSED;
  }

  getCurrentDoorStateOpen(): number {
    return this.Characteristic.CurrentDoorState.OPEN;
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
    const subscription = await this.garageClient.addSubscription(
	  [this.getTargetTopic(), this.getCurrentTopic(), this.getAvailabilityTopic()]);
	
    this.log.debug('mqtt subscriptions: ', subscription);
    this.garageClient.onMessage(this.receiveMessage.bind(this));
  }

  receiveMessage(topic: string, payload: Buffer) {
    const stringValue = payload.toString('ascii');
    this.log.debug('received topic: ', topic, 'payload: ', stringValue);
    switch (topic) {
      case this.getCurrentTopic():
      {
        let stateString = stringValue;
        try {
          const json = JSON.parse(stringValue) as { 
            valid: boolean;
            doorstate: string;
            detailedState: string;
            lamp: string;
          };
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
              this.garageAccessory?.updateLampState(json.lamp === 'true');
            }
            if (json.detailedState === 'stopped') {
              this.log.info('Door stopped');
              this.garageAccessory?.updateTargetDoorStateWithoutPublishing(this.Characteristic.TargetDoorState.OPEN);
            }
          } else {
            this.log.warn('GetCurrent topic: invalid or missing doorstate in payload: ', stringValue);
            break;
          }
        } catch (e) {
          this.log.warn('GetCurrent topic: failed to parse JSON payload: ', stringValue);
          break;
        }
        const value = this.mapCurrentDoorState(stateString);
        if (value >= 0) {
          this.garageAccessory?.updateCurrentDoorState(value);
          this.log.debug('did update current state to: ', value);
          if (stateString === 'open' || stateString === 'closed') {
            const targetValue = stateString === 'open'
              ? this.Characteristic.TargetDoorState.OPEN
              : this.Characteristic.TargetDoorState.CLOSED;
            this.garageAccessory?.updateTargetDoorStateWithoutPublishing(targetValue);
          }
        } else {
          this.log.error('GetCurrent topic: unknown door state value ', value, ' for payload: ', stateString);
        }
        break;
      }

      case this.getTargetTopic():
      {
        const value = this.mapTargetDoorState(stringValue);
        if (value > -1) {
          this.garageAccessory?.updateTargetDoorStateWithoutPublishing(value);
          this.log.debug('did update target state to:', value);
        } else {
          this.log.error('GetTarget topic: unknown door state value ', value, ' for payload: ', stringValue);
        }
        break;
      }
	  
	  case this.getAvailabilityTopic():
	    this.isOnline = stringValue === this.discovery.payloadAvailable;
	    this.log.info('Device availability:', stringValue);
	    break;

      default:
        this.log.debug('unhandled topic message: ', topic);
        break;
    }
  }
  
  getIsOnline(): boolean {
    return this.isOnline;
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
    const payload = value === this.Characteristic.TargetDoorState.OPEN ? 'open' : 'close';
    this.log.debug('publishing target door state: ', payload, ' to topic: ', this.getTargetTopic());
    this.garageClient?.publishValue(this.getTargetTopic(), payload);
  }
  
  getMqttStopMessage(): string {
    return (this.config['mqttStopMessage'] as string) ?? 'stop';
  }
  
  publishStopCommand() {
    this.log.debug('publishing stop command to topic: ', this.getTargetTopic());
    this.garageClient?.publishValue(this.getTargetTopic(), this.getMqttStopMessage());
  }
  
  getCurrentDetailedState(): string {
    return this.currentDetailedState;
  }

  isCurrentlyVenting(): boolean {
    return this.isVenting;
  }
  
}
