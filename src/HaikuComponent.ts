/**
 * Copyright (c) Haiku 2016-2018. All rights reserved.
 */

import {Curve} from './api/Curve';
import {BytecodeNode, BytecodeOptions, HaikuBytecode} from './api/HaikuBytecode';
import Config from './Config';
import HaikuBase, {GLOBAL_LISTENER_KEY} from './HaikuBase';
import HaikuClock from './HaikuClock';
import HaikuContext from './HaikuContext';
import HaikuElement from './HaikuElement';
import HaikuTimeline, {PlaybackSetting} from './HaikuTimeline';
import consoleErrorOnce from './helpers/consoleErrorOnce';
import cssMatchOne from './helpers/cssMatchOne';
import cssQueryList from './helpers/cssQueryList';
import {isPreviewMode} from './helpers/interactionModes';
import isMutableProperty from './helpers/isMutableProperty';
import manaFlattenTree from './helpers/manaFlattenTree';
import scopifyElements from './helpers/scopifyElements';
import xmlToMana from './helpers/xmlToMana';
import Layout3D from './Layout3D';
import {runMigrations} from './Migration';
import functionToRFO, {RFO} from './reflection/functionToRFO';
import StateTransitionManager, {StateTransitionParameters, StateValues} from './StateTransitionManager';
import ValueBuilder from './ValueBuilder';
import assign from './vendor/assign';

const pkg = require('./../package.json');
const VERSION = pkg.version;

const STRING_TYPE = 'string';
const OBJECT_TYPE = 'object';
const HAIKU_ID_ATTRIBUTE = 'haiku-id';
const DEFAULT_TIMELINE_NAME = 'Default';

const CSS_QUERY_MAPPING = {
  name: 'elementName',
  attributes: 'attributes',
  children: 'children',
};

/**
 * An interface for a "hot component" to patch into the renderer.
 *
 * Hot components are intended to be applied during hot editing when an immutable-looking thing happens to mutate
 * without marking the owner HaikuComponent instance for a full flush render.
 */
export interface HotComponent {
  timelineName: string;
  selector: string;
  propertyNames: string[];
}

export interface ClearCacheOptions {
  clearStates?: boolean;
}

const templateIsString = (
  template: BytecodeNode|string,
): template is string => typeof template === STRING_TYPE;

// tslint:disable:variable-name function-name
export default class HaikuComponent extends HaikuElement {
  builder;
  _flatManaTree;
  _horizonElements;
  isDeactivated;
  isSleeping;
  _matchedElementCache;
  _mutableTimelines;
  _states;

  bytecode;
  /**
   * @deprecated
   */
  _bytecode;
  config;
  container;
  context: HaikuContext;
  CORE_VERSION;
  doAlwaysFlush;
  doesNeedFullFlush;
  guests;
  host;
  playback;
  PLAYER_VERSION;
  registeredEventHandlers;
  state;
  stateTransitionManager: StateTransitionManager;

  constructor (
    bytecode: HaikuBytecode,
    context: HaikuContext,
    host: HaikuComponent,
    config: BytecodeOptions,
    container,
  ) {
    super();

    // We provide rudimentary support for passing the `template` as an XML string.
    if (templateIsString(bytecode.template)) {
      console.warn('[haiku core] converting template xml string to object');
      bytecode.template = xmlToMana(bytecode.template);
    }

    if (!bytecode.template) {
      console.warn('[haiku core] adding missing template object');
      bytecode.template = {elementName: 'div', attributes: {}, children: []};
    }

    if (!bytecode.timelines) {
      console.warn('[haiku core] adding missing timelines object');
      bytecode.timelines = {};
    }

    if (!bytecode.timelines[DEFAULT_TIMELINE_NAME]) {
      console.warn('[haiku core] adding missing default timeline');
      bytecode.timelines[DEFAULT_TIMELINE_NAME] = {};
    }

    if (!context) {
      throw new Error('Component requires a context');
    }

    if (!config) {
      throw new Error('Config options required');
    }

    if (!config.seed) {
      throw new Error('Seed value must be provided');
    }

    this.PLAYER_VERSION = VERSION; // #LEGACY
    this.CORE_VERSION = VERSION;

    this.context = context;
    this.container = container;

    this.host = host;
    this.guests = {};

    this.bytecode = (config.hotEditingMode)
      ? bytecode
      : clone(bytecode, this); // Important because migrations mutate the bytecode

    assertTemplate(this.bytecode.template);

    // Allow users to expose methods that can be called in event handlers
    if (this.bytecode.methods) {
      for (const methodNameGiven in this.bytecode.methods) {
        if (!this[methodNameGiven]) {
          this[methodNameGiven] = this.bytecode.methods[methodNameGiven].bind(this);
        }
      }
    }

    this.builder = new ValueBuilder(this);

    this._states = {}; // Storage for getter/setter actions in userland logic
    this.state = {}; // Public accessor object, e.g. this.state.foo = 1

    // Instantiate StateTransitions. Responsible to store and execute any state transition.
    this.stateTransitionManager = new StateTransitionManager(this.state, this.getClock());

    // `assignConfig` calls bindStates because our incoming config, which
    // could occur at any point during runtime, e.g. in React, may need to update internal states, etc.
    this.assignConfig(config);

    this._mutableTimelines = undefined;
    this._hydrateMutableTimelines();

    // The full version of the template gets mutated in-place by the rendering algorithm
    this._flatManaTree = [];

    // Flag used internally to determine whether we need to re-render the full tree or can survive by just patching
    this.doesNeedFullFlush = false;

    // If true, will continually flush the entire tree until explicitly set to false again
    this.doAlwaysFlush = false;

    // Dictionary of event handler names to handler functions; used to efficiently manage multiple subscriptions
    this.registeredEventHandlers = {};

    // As a performance optimization, keep track of elements we've located as key/value (selector/element) pairs
    this._matchedElementCache = {};

    // Dictionary of ids-to-elements, representing elements that we
    // do not want to render past in the tree (i.e. cede control to some
    // other rendering context)
    this._horizonElements = {};

    // Flag to determine whether this component should continue doing any work
    this.isDeactivated = false;

    // Flag to indicate whether we are sleeping, an ephemeral condition where no rendering occurs
    this.isSleeping = false;

    // Ensure full tree is are properly set up and all render nodes are connected to their models
    this.render({...this.config, forceApplyBehaviors: true});

    try {
      // If the bytecode we got happens to be in an outdated format, we automatically update it to the latest.
      runMigrations(
        this,
        {
          // Random seed for adding instance uniqueness to ids at runtime.
          referenceUniqueness: (config.hotEditingMode)
            ? undefined // During editing, Haiku.app pads ids unless this is undefined
            : Math.random().toString(36).slice(2),
        },
        VERSION,
      );
    } catch (e) {
      console.warn('[haiku core] caught error during migration', e);
    }

    // Start the default timeline to initiate the component;
    // run before the did-initialize hook in case the user wants to cancel
    this.startTimeline(DEFAULT_TIMELINE_NAME);

    this.routeEventToHandlerAndEmit(GLOBAL_LISTENER_KEY, 'component:did-initialize', [this]);

    // #FIXME: some handlers may still reference `_bytecode` directly.
    this._bytecode = this.bytecode;
  }

  /**
   * @description Track elements that are at the horizon of what we want to render, i.e., a list of
   * virtual elements that we don't want to make any updates lower than in the tree.
   */
  markHorizonElement (virtualElement) {
    if (virtualElement && virtualElement.attributes) {
      const flexId = virtualElement.attributes[HAIKU_ID_ATTRIBUTE] || virtualElement.attributes.id;
      if (flexId) {
        this._horizonElements[flexId] = virtualElement;
      }
    }
  }

  isHorizonElement (virtualElement) {
    if (virtualElement && virtualElement.attributes) {
      const flexId = virtualElement.attributes[HAIKU_ID_ATTRIBUTE] || virtualElement.attributes.id;
      return !!this._horizonElements[flexId];
    }
    return false;
  }

  registerGuest (subcomponent: HaikuComponent) {
    this.guests[subcomponent.getId()] = subcomponent;
  }

  visitGuestHierarchy (visitor: Function) {
    visitor(this, this.$id, this.host);
    for (const $id in this.guests) {
      this.guests[$id].visitGuestHierarchy(visitor);
    }
  }

  // If the component needs to remount itself for some reason, make sure we fire the right events
  callRemount (incomingConfig, skipMarkForFullFlush) {
    this.routeEventToHandlerAndEmit(GLOBAL_LISTENER_KEY, 'component:will-mount', [this]);

    // Note!: Only update config if we actually got incoming options!
    if (incomingConfig) {
      this.assignConfig(incomingConfig);
    }

    if (!skipMarkForFullFlush) {
      this.markForFullFlush();
      this.clearCaches(null);
    }

    // If autoplay is not wanted, stop the all timelines immediately after we've mounted
    // (We have to mount first so that the component displays, but then pause it at that state.)
    // If you don't want the component to show up at all, use options.automount=false.
    const timelineInstances = this.getTimelines();

    for (const timelineName in timelineInstances) {
      const timelineInstance = timelineInstances[timelineName];

      if (this.config.autoplay) {
        if (timelineName === DEFAULT_TIMELINE_NAME) {
          // Assume we want to start the timeline from the beginning upon remount.
          // NOTE:
          // timeline.play() will normally trigger markForFullFlush because it assumes we need to render
          // from the get-go. However, in case of a callRemount, we might not want to do that since it can be kind of
          // like running the first frame twice. So we pass the option into play so it can conditionally skip the
          // markForFullFlush step.
          if (!timelineInstance.isExplicitlyPaused()) {
            timelineInstance.play({skipMarkForFullFlush});
          }
        }
      } else {
        timelineInstance.pause();
      }
    }

    this.context.contextMount();

    this.routeEventToHandlerAndEmit(GLOBAL_LISTENER_KEY, 'component:did-mount', [this]);
  }

  destroy () {
    super.destroy();
    // Destroy all timelines we host.
    const timelineInstances = this.getTimelines();
    for (const timelineName in timelineInstances) {
      const timelineInstance = timelineInstances[timelineName];
      timelineInstance.destroy();
    }

    this.visitGuestHierarchy((component) => {
      // Clean up HaikuComponent dependents.
      // TODO: is this step necessary?
      if (component !== this) {
        component.destroy();
      }
    });

    this.visitDescendants((child) => {
      // Clean up HaikuElement dependents.
      child.destroy();
    });
  }

  callUnmount () {
    // Since we're unmounting, pause all animations to avoid unnecessary calc while detached
    const timelineInstances = this.getTimelines();
    for (const timelineName in timelineInstances) {
      const timelineInstance = timelineInstances[timelineName];
      timelineInstance.pause();
    }

    this.context.contextUnmount();

    this.routeEventToHandlerAndEmit(GLOBAL_LISTENER_KEY, 'component:will-unmount', [this]);
  }

  assignConfig (incomingConfig) {
    this.config = Config.build(this.config || {}, incomingConfig || {});

    // Don't assign the context config if we're a guest component;
    // assume only the top-level component should have this power
    if (this.host) {
      // Don't forget to update the configuration values shared by the context,
      // but skip component assignment so we don't end up in an infinite loop
      this.context.assignConfig(this.config, {skipComponentAssign: true});
    }

    const timelines = this.getTimelines();

    for (const name in timelines) {
      const timeline = timelines[name];
      timeline.assignOptions(this.config);
    }

    this.bindStates();

    assign(this.bytecode.timelines, this.config.timelines);

    return this;
  }

  set (key, value) {
    this.state[key] = value;
    return this;
  }

  get (key) {
    return this.state[key];
  }

  setState (states: StateValues, transitionParameter?: StateTransitionParameters) {

    // Do not set any state if invalid
    if (!states || typeof states !== 'object') {
      return this;
    }

    // Set states is delegated to stateTransitionManager
    this.stateTransitionManager.setState(states, transitionParameter);

    return this;

  }

  getStates () {
    return this.state;
  }

  clearCaches (options: ClearCacheOptions = {}) {
    this.cacheClear();

    // Don't forget to repopulate the states with originals when we cc otherwise folks
    // who depend on initial states being set will be SAD!
    if (options.clearStates) {
      this._states = {};
      this.bindStates();
    }

    this._flatManaTree = manaFlattenTree(this.getTemplate(), CSS_QUERY_MAPPING);
    this._matchedElementCache = {};
    this.builder.clearCaches(options);
    this._hydrateMutableTimelines();

    // These may have been set for caching purposes
    if (this.bytecode.timelines) {
      for (const timelineName in this.bytecode.timelines) {
        delete this.bytecode.timelines[timelineName].__max;
      }
    }
  }

  getClock (): HaikuClock {
    return this.context.getClock();
  }

  getTemplate (): any {
    return this.bytecode.template;
  }

  getTimelines () {
    return this.cacheFetch('getTimelines', () => {
      return this.fetchTimelines();
    });
  }

  fetchTimelines () {
    const names = Object.keys(this.bytecode.timelines);

    for (let i = 0; i < names.length; i++) {
      const name = names[i];

      if (!name) {
        continue;
      }

      const existing = HaikuTimeline.where({
        name,
        component: this,
      })[0];

      if (!existing) {
        HaikuTimeline.create(
          this,
          name,
          this.getTimelineDescriptor(name),
          this.config,
        );
      }
    }

    const out = {};

    HaikuTimeline.where({component: this}).forEach((timeline) => {
      out[timeline.getName()] = timeline;
    });

    return out;
  }

  getTimeline (name): HaikuTimeline {
    return this.getTimelines()[name];
  }

  fetchTimeline (name, descriptor): HaikuTimeline {
    const found = this.getTimeline(name);

    if (found) {
      return found;
    }

    return HaikuTimeline.create(this, name, descriptor, this.config);
  }

  getDefaultTimeline (): HaikuTimeline {
    const timelines = this.getTimelines();
    return timelines[DEFAULT_TIMELINE_NAME];
  }

  stopAllTimelines () {
    const timelines = this.getTimelines();
    for (const name in timelines) {
      this.stopTimeline(name);
    }
  }

  startAllTimelines () {
    const timelines = this.getTimelines();
    for (const name in timelines) {
      this.startTimeline(name);
    }
  }

  startTimeline (timelineName) {
    const time = this.context.clock.getExplicitTime();
    const descriptor = this.getTimelineDescriptor(timelineName);
    const existing = this.fetchTimeline(timelineName, descriptor);
    if (existing) {
      existing.start(time, descriptor);
    }
  }

  stopTimeline (timelineName) {
    const time = this.context.clock.getExplicitTime();
    const descriptor = this.getTimelineDescriptor(timelineName);
    const existing = this.getTimeline(timelineName);
    if (existing) {
      existing.stop(time, descriptor);
    }
  }

  getTimelineDescriptor (timelineName) {
    return this.bytecode.timelines[timelineName];
  }

  getInjectables (): any {
    const injectables = {};

    assign(injectables, this.builder.getSummonablesSchema());

    // Local states get precedence over global summonables, so assign them last
    for (const key in this._states) {
      let type = this._states[key].type;
      if (!type) {
        type = typeof this._states[key];
      }
      injectables[key] = type;
    }

    return injectables;
  }

  /**
   * @method _deactivate
   * @description When hot-reloading a component during editing, this can be used to
   * ensure that this component doesn't keep updating after its replacement is loaded.
   */
  deactivate () {
    this.isDeactivated = true;
  }

  activate () {
    this.isDeactivated = false;
  }

  sleepOn () {
    this.isSleeping = true;
  }

  sleepOff () {
    this.isSleeping = false;
  }

  /**
   * @method dump
   * @description Dump serializable info about this object
   */
  dump () {
    const metadata = this.getBytecodeMetadata();
    return `${metadata.relpath}:${this.getComponentId()}`;
  }

  getBytecodeMetadata () {
    return this.bytecode.metadata;
  }

  getBytecodeRelpath (): string {
    const metadata = this.getBytecodeMetadata();
    return metadata && metadata.relpath;
  }

  getBytecodeProject (): string {
    const metadata = this.getBytecodeMetadata();
    return metadata && metadata.project;
  }

  getBytecodeOrganization (): string {
    const metadata = this.getBytecodeMetadata();
    return metadata && metadata.organization;
  }

  getAddressableProperties (out = {}) {
    if (!this.bytecode.states) {
      return out;
    }

    for (const name in this.bytecode.states) {
      const state = this.bytecode.states[name];

      out[name] = {
        name,
        type: 'state', // As opposed to a 'native' property like fill-rule
        prefix: name, // States aren't named like rotation.x, so there is no 'prefix'
        suffix: undefined, // States aren't named like rotation.x, so there is no 'suffix'
        fallback: state.value, // Weird nomenclature: In Haiku.app, fallback means the default value
        typedef: state.type, // Weird nomenclature: In Haiku.app, typedef just means the runtime type
        mock: state.mock, // Just in case needed by someone
        target: this, // Used for tracking convenience; may also be an 'element'; do not remove
        value: () => { // Lazy because this may change over time and we don't want to require re-query
          return this.state[name]; // The current live value of this state as seen by the app
        },
      };
    }

    return out;
  }

  bindStates () {
    const allStates = assign({}, this.bytecode.states, this.config.states);

    for (const stateSpecName in allStates) {
      const stateSpec = allStates[stateSpecName];

      // 'null' is the signal for an empty prop, not undefined.
      if (stateSpec.value === undefined) {
        console.error(
          'Property `' +
          stateSpecName +
          '` cannot be undefined; use null for empty states',
        );

        continue;
      }

      const isValid = stateSpecValidityCheck(stateSpec, stateSpecName);

      if (isValid) {
        this._states[stateSpecName] = stateSpec.value;

        this.defineSettableState(stateSpec, stateSpecName);
      }
    }
  }

  defineSettableState (
    stateSpec,
    stateSpecName: string,
  ) {
    // Note: We define the getter/setter on the object itself, but the storage occurs on the pass-in statesTargetObject
    Object.defineProperty(this.state, stateSpecName, {
      configurable: true,

      get: () => {
        return this._states[stateSpecName];
      },

      set: (inputValue) => {
        if (stateSpec.setter) {
          // Important: We call the setter with a binding of the component, so it can access methods on `this`
          this._states[stateSpecName] = stateSpec.setter.call(
            this,
            inputValue,
          );
        } else {
          this._states[stateSpecName] = inputValue;
        }

        if (!this.isDeactivated) {
          this.emit('state:set', stateSpecName, this._states[stateSpecName]);
        }

        return this._states[stateSpecName];
      },
    });
  }

  allEventHandlers (): any {
    return assign(
      {},
      this.bytecode.eventHandlers,
      this.config.eventHandlers,
    );
  }

  eachEventHandler (iteratee: Function) {
    const eventHandlers = this.allEventHandlers();

    for (const eventSelector in eventHandlers) {
      for (const eventName in eventHandlers[eventSelector]) {
        const descriptor = eventHandlers[eventSelector][eventName];

        if (!descriptor || !descriptor.handler) {
          continue;
        }

        iteratee(
          eventSelector,
          eventName,
          descriptor,
        );
      }
    }
  }

  routeEventToHandler (
    eventSelectorGiven: string,
    eventNameGiven: string,
    eventArgs: any,
  ) {
    if (this.isDeactivated) {
      return;
    }

    this.eachEventHandler((eventSelector, eventName, {handler}) => {
      if (eventNameGiven === eventName) {
        if (
          eventSelectorGiven === eventSelector ||
          eventSelectorGiven === GLOBAL_LISTENER_KEY
        ) {
          this.callEventHandler(eventSelector, eventName, handler, eventArgs);
          return;
        }
      }
    });
  }

  callEventHandler (eventsSelector: string, eventName: string, handler: Function, eventArgs: any): any {
    // Only fire the event listeners if the component is in 'live' interaction mode,
    // i.e., not currently being edited inside the Haiku authoring environment
    if (!isPreviewMode(this.config.interactionMode)) {
      return;
    }

    try {
      return handler.apply(this, eventArgs);
    } catch (exception) {
      consoleErrorOnce(exception);
    }
  }

  routeEventToHandlerAndEmit (
    eventSelectorGiven: string,
    eventNameGiven: string,
    eventArgs: any,
  ) {
    if (this.isDeactivated) {
      return;
    }

    this.routeEventToHandler(eventSelectorGiven, eventNameGiven, eventArgs);
    this.emit(eventNameGiven, ...eventArgs);
  }

  markForFullFlush () {
    this.doesNeedFullFlush = true;
    return this;
  }

  unmarkForFullFlush () {
    this.doesNeedFullFlush = false;
    return this;
  }

  shouldPerformFullFlush () {
    return this.doesNeedFullFlush || this.doAlwaysFlush;
  }

  performFullFlushRenderWithRenderer (renderer, options: any = {}) {
    this.context.getContainer(true); // Force recalc of container
    const tree = this.render(options);

    // Since we just produced a full tree, we don't need a further full flush.
    this.unmarkForFullFlush();

    // Undefined signals there is no update to be made
    if (tree !== undefined) {
      return renderer.render(
        this.container,
        tree,
        this,
      );
    }
  }

  render (options: any = {}) {
    // We register ourselves with our host here because render is guaranteed to be called
    // both in our constructor and in the case that we were deactivated/reactivated.
    // This must run before the isDeactivated check since we may use the registry to activate later.
    if (this.host) {
      this.host.registerGuest(this);
    }

    if (this.isDeactivated) {
      // If deactivated, pretend like there is nothing to render
      return;
    }

    this._flatManaTree = manaFlattenTree(this.getTemplate(), CSS_QUERY_MAPPING);
    this._matchedElementCache = {};

    const expansion = expandTreeNode(
      this.getTemplate(), // node
      this.container, // parent
      this, // instance (component)
      this.context,
      this.host,
      options,
      true, // doConnectInstanceToNode
    );

    scopifyElements(expansion, null, null);

    this.applyContextChanges(
      expansion,
      options,
    );

    return expansion;
  }

  performPatchRenderWithRenderer (renderer, options: any = {}, skipCache: boolean) {
    if (renderer.shouldCreateContainer) {
      this.context.getContainer(true); // Force recalc of container
    }

    const patches = this.patch(options, skipCache);

    renderer.patch(
      this,
      patches,
    );

    for (const $id in this.guests) {
      this.guests[$id].performPatchRenderWithRenderer(
        renderer,
        options,
        skipCache,
      );
    }
  }

  patch (options = {}, skipCache = false) {
    if (this.isDeactivated) {
      // If deactivated, pretend like there is nothing to render
      return {};
    }

    return this.gatherDeltaPatches(
      this.getTemplate(),
      options,
      skipCache,
    );
  }

  applyContextChanges (
    template,
    options: any = {},
  ) {
    Layout3D.initializeTreeAttributes(template, true);

    this.applyBehaviors(
      null,
      options,
      false, // isPatchOperation
      false, // skipCache
    );

    if (this.context.renderer.mount) {
      this.eachEventHandler((eventSelector, eventName) => {
        const registrationKey = `${eventSelector}:${eventName}`;

        if (this.registeredEventHandlers[registrationKey]) {
          return;
        }

        this.registeredEventHandlers[registrationKey] = true;

        this.context.renderer.mountEventListener(this, eventSelector, eventName, (...args) => {
          this.routeEventToHandlerAndEmit(eventSelector, eventName, args);
        });
      });
    }

    if (!this.host && options.sizing) {
      computeAndApplyPresetSizing(
        template,
        this.container,
        options.sizing,
        null,
      );
    }

    computeAndApplyTreeLayouts(
      template,
      this.container,
      options,
      this.context,
    );
  }

  gatherDeltaPatches (
    template,
    options: any = {},
    skipCache = false,
  ) {
    // This is what we're going to return: a dictionary of ids to elements
    const deltas = {};

    Layout3D.initializeTreeAttributes(template, true);

    this.applyBehaviors(
      deltas,
      options,
      true, // isPatchOperation
      skipCache,
    );

    if (!this.host && options.sizing) {
      computeAndApplyPresetSizing(
        template,
        this.container,
        options.sizing,
        deltas,
      );
    }

    // TODO: Calculating the tree layout should be skipped for already visited node
    // that we have already calculated among the descendants of the changed one
    for (const flexId in deltas) {
      const changedNode = deltas[flexId];

      computeAndApplyTreeLayouts(
        changedNode,
        changedNode.__parent,
        options,
        this.context,
      );
    }

    return deltas;
  }

  applyBehaviors (
    deltas,
    options,
    isPatchOperation,
    skipCache = false,
  ) {
    const globalClockTime = this.context.clock.getExplicitTime();

    for (const timelineName in this.bytecode.timelines) {
      const timelineInstance = this.getTimeline(timelineName);

      // If we update with the global clock time while a timeline is paused, the next
      // time we resume playing it will "jump forward" to the time that has elapsed.
      if (timelineInstance.isPlaying()) {
        timelineInstance.doUpdateWithGlobalClockTime(globalClockTime);
      }

      const timelineTime = timelineInstance.getBoundedTime();

      const timelineDescriptor = this.bytecode.timelines[timelineName];

      // In hot editing mode, any timeline is fair game for mutation,
      // even if it's not actually animated (e.g. dragging an SVG at keyframe 0).
      const mutableTimelineDescriptor = isPatchOperation
        ? this._mutableTimelines[timelineName]
        : timelineDescriptor;

      if (!mutableTimelineDescriptor || typeof mutableTimelineDescriptor !== 'object') {
        continue;
      }

      for (const behaviorSelector in mutableTimelineDescriptor) {
        const propertiesGroup = timelineDescriptor[behaviorSelector];

        if (!propertiesGroup) {
          continue;
        }

        const hasExpressions = propertyGroupNeedsExpressionEvaluated(
          propertiesGroup,
          timelineTime,
        );

        if (
          options.forceApplyBehaviors ||
          (timelineInstance.isPlaying() && timelineInstance.isUnfinished()) ||
          hasExpressions
        ) {
          // proceed
        } else {
          continue;
        }

        // This is our opportunity to group property operations that need to be in order
        const propertyOperations = collatePropertyGroup(propertiesGroup);

        for (let i = 0; i < propertyOperations.length; i++) {
          const propertyGroup = propertyOperations[i];

          const matchingElementsForBehavior = findMatchingElementsByCssSelector(
            behaviorSelector,
            this._flatManaTree,
            this._matchedElementCache,
          );

          if (!matchingElementsForBehavior || matchingElementsForBehavior.length < 1) {
            continue;
          }

          for (let j = 0; j < matchingElementsForBehavior.length; j++) {
            const matchingElement = matchingElementsForBehavior[j];

            const domId = (
              matchingElement &&
              matchingElement.attributes &&
              matchingElement.attributes.id
            );

            const haikuId = (
              matchingElement &&
              matchingElement.attributes &&
              matchingElement.attributes[HAIKU_ID_ATTRIBUTE]
            );

            const flexId = haikuId || domId;

            for (const propertyName in propertyGroup) {
              const propertyValue = propertyGroup[propertyName];

              const finalValue = this.builder.build(
                timelineName,
                timelineTime,
                flexId,
                matchingElement,
                propertyName,
                propertyValue,
                isPatchOperation,
                this,
                skipCache,
              );

              if (finalValue !== undefined) {
                this.applyPropertyToNode(
                  matchingElement,
                  propertyName,
                  finalValue,
                  timelineInstance,
                );

                // If even one change has been applied, the element must be patched
                if (deltas) {
                  deltas[flexId] = matchingElement;
                }
              }
            }
          }
        }
      }
    }
  }

  applyPropertyToNode (
    node,
    name: string,
    value,
    timeline: HaikuTimeline,
  ) {
    const sender = (node.__instance) ? node.__instance : this; // Who sent the command
    const receiver = node.__subcomponent || node.__receiver;
    const type = (receiver && receiver.tagName) || node.elementName;
    const addressables = receiver && receiver.getAddressableProperties();
    const addressee = addressables && addressables[name] !== undefined && receiver;

    if (addressee) {
      addressee.set(name, value);
    }

    const vanity = getVanity(type, name);

    if (vanity) {
      return vanity(
        name,
        node,
        value,
        this.context,
        timeline,
        receiver,
        sender,
      );
    }

    const parts = name.split('.');

    if (parts[0] === 'style' && parts[1]) {
      return setStyle(parts[1], node, value);
    }

    return setAttribute(name, node, value);
  }

  findElementsByHaikuId (componentId) {
    return findMatchingElementsByCssSelector(
      'haiku:' + componentId,
      this._flatManaTree,
      this._matchedElementCache,
    );
  }

  _hydrateMutableTimelines () {
    this._mutableTimelines = {};
    if (this.bytecode.timelines) {
      for (const timelineName in this.bytecode.timelines) {
        for (const selector in this.bytecode.timelines[timelineName]) {
          for (const propertyName in this.bytecode.timelines[timelineName][selector]) {
            if (isMutableProperty(this.bytecode.timelines[timelineName][selector][propertyName], propertyName)) {
              const timeline = this._mutableTimelines[timelineName] || {};
              const propertyGroup = timeline[selector] || {};
              this._mutableTimelines = {
                ...this._mutableTimelines,
                [timelineName]: {
                  ...timeline,
                  [selector]: {
                    ...propertyGroup,
                    [propertyName]: this.bytecode.timelines[timelineName][selector][propertyName],
                  },
                },
              };
            }
          }
        }
      }
    }
  }

  addHotComponent (hotComponent: HotComponent) {
    if (
      !this.bytecode.timelines ||
      !this.bytecode.timelines[hotComponent.timelineName] ||
      !this.bytecode.timelines[hotComponent.timelineName][hotComponent.selector]
    ) {
      return;
    }

    const propertyGroup = this.bytecode.timelines[hotComponent.timelineName][hotComponent.selector];

    const timeline = this._mutableTimelines[hotComponent.timelineName] || {};
    const mutablePropertyGroup = timeline[hotComponent.selector] || {};

    this._mutableTimelines = {
      ...this._mutableTimelines,
      [hotComponent.timelineName]: {
        ...timeline,
        [hotComponent.selector]: {
          ...mutablePropertyGroup,
          ...hotComponent.propertyNames.reduce(
            (hotProperties, propertyName) => (hotProperties[propertyName] = propertyGroup[propertyName], hotProperties),
            {},
          ),
        },
      },
    };
  }

  controlTime (timelineName: string, timelineTime: number) {
    const explicitTime = this.context.clock.getExplicitTime();
    const timelineInstances = this.getTimelines();

    for (const localTimelineName in timelineInstances) {
      if (localTimelineName === timelineName) {
        const timelineInstance = timelineInstances[timelineName];
        timelineInstance.controlTime(timelineTime, explicitTime);
      }
    }

    for (const $id in this.guests) {
      this.guests[$id].controlTime(
        timelineName,
        this.getControlledTimeDefinedForGuestComponent(
          this.guests[$id],
          timelineName,
          timelineTime,
        ),
      );
    }
  }

  getControlledTimeDefinedForGuestComponent (
    guest: HaikuComponent,
    timelineName: string,
    timelineTime: number,
  ): number {
    const wrapper = guest.parentNode;

    if (!wrapper) {
      return timelineTime;
    }

    const wrapperId = wrapper.attributes && wrapper.attributes[HAIKU_ID_ATTRIBUTE];

    if (!wrapperId) {
      return timelineTime;
    }

    const playbackValue = this.getOutputValue(
      timelineName,
      timelineTime,
      wrapperId,
      'playback',
    );

    if (typeof playbackValue === 'number') {
      return playbackValue;
    }

    const guestTimeline = guest.getTimeline(timelineName);

    if (playbackValue === PlaybackSetting.CEDE) {
      return guestTimeline.getTime();
    }

    // If time is controlled and we're set to 'loop', use a modulus of the guest's max time
    // which will give the effect of looping the guest to its 0 if its max has been reached
    if (playbackValue === PlaybackSetting.LOOP) {
      if (guestTimeline) {
        const guestMax = guestTimeline.getMaxTime();
        const finalTime = timelineTime % guestMax; // TODO: What if final frame has a change?
        return finalTime;
      }

      return timelineTime;
    }

    if (playbackValue === PlaybackSetting.STOP) {
      if (guestTimeline) {
        return guestTimeline.getControlledTime() || 0;
      }

      return timelineTime;
    }

    return timelineTime;
  }

  getPropertiesGroup (timelineName: string, flexId: string) {
    return (
      this.bytecode &&
      this.bytecode.timelines &&
      this.bytecode.timelines[timelineName] &&
      this.bytecode.timelines[timelineName][`haiku:${flexId}`]
    );
  }

  getOutputValue (
    timelineName: string,
    timelineTime: number,
    flexId: string,
    propertyName: string,
  ): any {
    return this.builder.grabValue(
      timelineName,
      flexId,
      null, // matchingElement - not needed?
      propertyName,
      this.getPropertiesGroup(timelineName, flexId),
      timelineTime,
      this, // hostInstance
      false, // isPatchOperation
      false, // skipCache
      false, // clearSortedKeyframesCache
    );
  }

  /**
   * Execute state transitions.
   */
  tickStateTransitions (): void {
    this.stateTransitionManager.tickStateTransitions();
  }

  /**
   * Reset states to initial values by using State Transitions. Default to linear
   */
  resetStatesToInitialValuesWithTransition (duration: number, curve: Curve = Curve.Linear) {
    // Build initial states
    const initialStates = assign({}, this.bytecode.states, this.config.states);
    for (const key in initialStates) {
      initialStates[key] = initialStates[key].value;
    }
    // Create state transition to initial state values
    this.stateTransitionManager.setState(initialStates, {curve, duration});
  }

  static __name__ = 'HaikuComponent';

  static PLAYER_VERSION = VERSION; // #LEGACY
  static CORE_VERSION = VERSION;

  static all = (): HaikuComponent[] => HaikuBase.getRegistryForClass(HaikuComponent);
}

const STRUCTURE_PROPERTIES = {
  'controlFlow.repeat': true,
  'controlFlow.if': true,
  'controlFlow.placeholder': true,
};

const collatePropertyGroup = (propertiesGroup) => {
  const structuralOps = {};
  const presentationalOps = {};

  for (const propertyName in propertiesGroup) {
    if (STRUCTURE_PROPERTIES[propertyName]) {
      structuralOps[propertyName] = propertiesGroup[propertyName];
    } else {
      presentationalOps[propertyName] = propertiesGroup[propertyName];
    }
  }

  return [structuralOps, presentationalOps];
};

function isBytecode (thing) {
  return thing && typeof thing === OBJECT_TYPE && thing.template;
}

function assertTemplate (template) {
  if (!template) {
    throw new Error('Empty template not allowed');
  }

  if (typeof template === OBJECT_TYPE) {
    if (template.attributes) {
      if (!template.attributes[HAIKU_ID_ATTRIBUTE]) {
        console.warn('[haiku core] bytecode template has no id');
      }
    } else {
      console.warn('[haiku core] bytecode template has no attributes');
    }

    if (!template.elementName) {
      console.warn('[haiku core] unexpected bytecode template format');
    }

    return template;
  }

  throw new Error('Unknown bytecode template format');
}

function stateSpecValidityCheck (stateSpec: any, stateSpecName: string): boolean {
  if (
    stateSpec.type === 'any' ||
    stateSpec.type === '*' ||
    stateSpec.type === undefined ||
    stateSpec.type === null
  ) {
    return true;
  }

  if (stateSpec.type === 'event' || stateSpec.type === 'listener') {
    if (
      typeof stateSpec.value !== 'function' &&
      stateSpec.value !== null &&
      stateSpec.value !== undefined
    ) {
      console.error(
        'Property value `' +
        stateSpecName +
        '` must be an event listener function',
      );

      return false;
    }

    return true;
  }

  if (stateSpec.type === 'array') {
    if (!Array.isArray(stateSpec.value)) {
      console.error(
        'Property value `' + stateSpecName + '` must be an array',
      );

      return false;
    }
  } else if (stateSpec.type === 'object') {
    if (stateSpec.value && typeof stateSpec.value !== 'object') {
      console.error(
        'Property value `' + stateSpecName + '` must be an object',
      );

      return false;
    }
  } else {
    if (typeof stateSpec.value !== stateSpec.type) {
      console.error(
        'Property value `' + stateSpecName + '` must be a `' + stateSpec.type + '`',
      );

      return false;
    }
  }

  return true;
}

const msKeyToInt = (msKey: string): number => {
  return parseInt(msKey, 10);
};

const propertyGroupNeedsExpressionEvaluated = (
  propertyGroup,
  timelineTime: number,
): boolean => {
  let foundExpressionForTime = false;

  const roundedTime = Math.round(timelineTime);

  for (const propertyName in propertyGroup) {
    const propertyKeyframes = propertyGroup[propertyName];

    const keyframeMss = Object.keys(propertyKeyframes).map(msKeyToInt).sort();

    if (keyframeMss.length < 1) {
      return;
    }

    let leftBookend = 0;
    let rightBookend = keyframeMss[keyframeMss.length - 1];

    for (let i = 0; i < keyframeMss.length; i++) {
      const currMs = keyframeMss[i];

      if (currMs >= leftBookend && currMs <= roundedTime) {
        leftBookend = currMs;
      }

      if (currMs <= rightBookend && currMs >= roundedTime) {
        rightBookend = currMs;
      }
    }

    if (propertyKeyframes[leftBookend] && typeof propertyKeyframes[leftBookend].value === 'function') {
      foundExpressionForTime = true;
    } else if (propertyKeyframes[rightBookend] && typeof propertyKeyframes[rightBookend].value === 'function') {
      foundExpressionForTime = true;
    }
  }

  return foundExpressionForTime;
};

function connectInstanceNodeWithHostComponent (node, host) {
  const flexId = (
    node &&
    node.attributes &&
    (node.attributes[HAIKU_ID_ATTRIBUTE] || node.attributes.id)
  );

  // Clear the previous listener (avoid multiple subscriptions to the same event)
  if (node.__listener) {
    node.__instance.off('*', node.__listener);
  }

  node.__listener = (key, ...args) => {
    host.routeEventToHandler(
      `haiku:${flexId}`,
      key,
      [node.__instance].concat(args),
    );
  };

  // Bubble emitted events to the host component so it can subscribe declaratively
  node.__instance.on('*', node.__listener);
}

function expandTreeNode (
  node,
  parent,
  component: HaikuComponent,
  context: HaikuContext,
  host: HaikuComponent,
  options: any = {},
  doConnectInstanceToNode: boolean,
) {
  // Nothing to expand if the node happens to be text or unexpected type
  if (!node || typeof node !== 'object') {
    return node;
  }

  // Give it a pointer back to the host context; used by HaikuElement
  node.__context = context;

  // Platform renderers may depend on access to the parent
  node.__parent = parent;

  // Give instances a pointer to their node and vice versa
  if (doConnectInstanceToNode) {
    node.__instance = component;

    HaikuElement.connectNodeWithElement(node, node.__instance);

    if (host) {
      connectInstanceNodeWithHostComponent(
        node,
        host,
      );
    }
  }

  if (typeof node.elementName === STRING_TYPE) {
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        node.children[i] = expandTreeNode(
          node.children[i], // node
          node, // parent
          component, // instance (component)
          context,
          host,
          options,
          false,
        );
      }
    }

    return node;
  }

  if (isBytecode(node.elementName)) {
    let subtree;

    // Example structure showing how nodes and instances are related:
    // <div root> instance id=1
    //   <div>
    //     <div>
    //       <div wrap> subcomponent (instance id=2)
    //         <div root> instance id=2
    //           ...
    if (!node.__subcomponent) {
      // Note: .render and thus .expandTree are called by the constructor,
      // automatically connecting the root node to itself (see stanza above).
      node.__subcomponent = new HaikuComponent(
        node.elementName,
        context, // context
        component, // host
        Config.buildChildSafeConfig({...context.config, ...options}),
        node, // container
      );

      subtree = node.__subcomponent.getTemplate();
    } else {
      // Reassigning is necessary since these objects may have changed between
      // renders in the editing environment
      node.__subcomponent.context = context; // context
      node.__subcomponent.host = component; // host
      node.__subcomponent.container = node; // container

      subtree = node.__subcomponent.render({
        ...node.__subcomponent.config,
        ...Config.buildChildSafeConfig(options),
      });

      // Don't re-start any nested timelines that have been explicitly paused
      if (!node.__subcomponent.getDefaultTimeline().isExplicitlyPaused()) {
        node.__subcomponent.startTimeline(DEFAULT_TIMELINE_NAME);
      }
    }

    if (subtree) {
      node.children = [subtree];
    }

    return node;
  }

  // In case we got a __reference node or other unknown
  console.warn('[haiku core] cannot expand node');
  return node;
}

function findMatchingElementsByCssSelector (selector, flatManaTree, cache) {
  if (cache[selector]) {
    return cache[selector];
  }

  return cache[selector] = cssQueryList(flatManaTree, selector, CSS_QUERY_MAPPING);
}

function computeAndApplyTreeLayouts (tree, container, options, context) {
  if (!tree || typeof tree === 'string') {
    return void 0;
  }

  computeAndApplyNodeLayout(tree, container);

  if (!tree.children || tree.children.length < 1) {
    return void 0;
  }

  for (let i = 0; i < tree.children.length; i++) {
    computeAndApplyTreeLayouts(tree.children[i], tree, options, context);
  }
}

function computeAndApplyNodeLayout (node, parent) {
  // No point proceeding if our parent node doesn't have a computed layout
  if (parent && parent.layout && parent.layout.computed) {
    const parentSize = parent.layout.computed.size;

    // Don't assume the node has/needs a layout, for example, control-flow injectees
    if (node.layout && node.layout.matrix) {
      node.layout.computed = Layout3D.computeLayout(
        node.layout,
        node.layout.matrix,
        parentSize,
        Layout3D.computeSizeOfNodeContent(node),
      );
    }
  }
}

function computeAndApplyPresetSizing (element, container, mode, deltas) {
  const elementWidth = element.layout.sizeAbsolute.x;
  const elementHeight = element.layout.sizeAbsolute.y;

  const containerWidth = container.layout.computed.size.x;
  const containerHeight = container.layout.computed.size.y;

  // I.e., the amount by which we'd have to multiply the element's scale to make it
  // exactly the same size as its container (without going above it)
  const scaleDiffX = containerWidth / elementWidth;
  const scaleDiffY = containerHeight / elementHeight;

  // This makes sure that the sizing occurs with respect to a correct and consistent origin point,
  // but only if the user didn't happen to explicitly set this value (we allow their override).
  if (!element.attributes.style['transform-origin']) {
    element.attributes.style['transform-origin'] = '0% 0% 0px';
  }

  // IMPORTANT: If any value has been changed on the element, you must set this to true.
  // Otherwise the changed object won't go into the deltas dictionary, and the element won't update.
  let changed = false;

  switch (mode) {
    // Make the base element its default scale, which is just a multiplier of one. This is the default.
    case 'normal':
      if (element.layout.scale.x !== 1.0 || element.layout.scale.y !== 1.0) {
        changed = true;
        element.layout.scale.x = element.layout.scale.y = 1.0;
      }
      break;

    // Stretch the element to fit the container on both x and y dimensions (distortion allowed)
    case 'stretch':
      if (scaleDiffX !== element.layout.scale.x) {
        changed = true;
        element.layout.scale.x = scaleDiffX;
      }
      if (scaleDiffY !== element.layout.scale.y) {
        changed = true;
        element.layout.scale.y = scaleDiffY;
      }
      break;

    // CONTAIN algorithm
    // see https://developer.mozilla.org/en-US/docs/Web/CSS/background-size?v=example
    // A keyword that scales the image as large as possible and maintains image aspect ratio
    // (image doesn't get squished). Image is letterboxed within the container.
    // When the image and container have different dimensions, the empty areas (either top/bottom of left/right)
    // are filled with the background-color.
    case 'contain':
    case true: // (Legacy.)
      let containScaleToUse = null;

      // We're looking for the larger of the two scales that still allows both dimensions to fit in the box
      // The rounding is necessary to avoid precision issues, where we end up comparing e.g. 2.0000000000001 to 2
      if (
        ~~(scaleDiffX * elementWidth) <= containerWidth &&
        ~~(scaleDiffX * elementHeight) <= containerHeight
      ) {
        containScaleToUse = scaleDiffX;
      }
      if (
        ~~(scaleDiffY * elementWidth) <= containerWidth &&
        ~~(scaleDiffY * elementHeight) <= containerHeight
      ) {
        if (containScaleToUse === null) {
          containScaleToUse = scaleDiffY;
        } else {
          if (scaleDiffY >= containScaleToUse) {
            containScaleToUse = scaleDiffY;
          }
        }
      }

      if (element.layout.scale.x !== containScaleToUse) {
        changed = true;
        element.layout.scale.x = containScaleToUse;
      }
      if (element.layout.scale.y !== containScaleToUse) {
        changed = true;
        element.layout.scale.y = containScaleToUse;
      }

      // Offset the translation so that the element remains centered within the letterboxing
      const containTranslationOffsetX = -(containScaleToUse * elementWidth - containerWidth) / 2;
      const containTranslationOffsetY = -(containScaleToUse * elementHeight - containerHeight) / 2;
      if (element.layout.translation.x !== containTranslationOffsetX) {
        changed = true;
        element.layout.translation.x = containTranslationOffsetX;
      }
      if (element.layout.translation.y !== containTranslationOffsetY) {
        changed = true;
        element.layout.translation.y = containTranslationOffsetY;
      }

      break;

    // COVER algorithm (inverse of CONTAIN)
    // see https://developer.mozilla.org/en-US/docs/Web/CSS/background-size?v=example
    // A keyword that is the inverse of contain. Scales the image as large as possible and maintains
    // image aspect ratio (image doesn't get squished). The image "covers" the entire width or height
    // of the container. When the image and container have different dimensions, the image is clipped
    // either left/right or top/bottom.
    case 'cover':
      let coverScaleToUse = null;

      // We're looking for the smaller of two scales that ensures the entire box is covered.
      // The rounding is necessary to avoid precision issues, where we end up comparing e.g. 2.0000000000001 to 2
      if (~~(scaleDiffX * elementHeight) >= containerHeight) {
        coverScaleToUse = scaleDiffX;
      } else if (~~(scaleDiffY * elementWidth) >= containerWidth) {
        coverScaleToUse = scaleDiffY;
      } else {
        coverScaleToUse = Math.max(scaleDiffX, scaleDiffY);
      }

      if (element.layout.scale.x !== coverScaleToUse) {
        changed = true;
        element.layout.scale.x = coverScaleToUse;
      }
      if (element.layout.scale.y !== coverScaleToUse) {
        changed = true;
        element.layout.scale.y = coverScaleToUse;
      }

      // Offset the translation so that the element remains centered despite clipping
      const coverTranslationOffsetX = -(coverScaleToUse * elementWidth - containerWidth) / 2;
      const coverTranslationOffsetY = -(coverScaleToUse * elementHeight - containerHeight) / 2;
      if (element.layout.translation.x !== coverTranslationOffsetX) {
        changed = true;
        element.layout.translation.x = coverTranslationOffsetX;
      }
      if (element.layout.translation.y !== coverTranslationOffsetY) {
        changed = true;
        element.layout.translation.y = coverTranslationOffsetY;
      }

      break;
  }

  if (changed && deltas) {
    // Part of the render/update system involves populating a dictionary of per-element updates,
    // which explains why instead of returning a value here, we assign the updated element.
    // The 'deltas' dictionary is passed to us from the render functions upstream of here.
    deltas[element.attributes[HAIKU_ID_ATTRIBUTE]] = element;
  }
}

export interface ClonedFunction {
  (...args: any[]): void;
  __rfo?: RFO;
}

const clone = (value, binding) => {
  if (!value) {
    return value;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'function') {
    const fn: ClonedFunction = (...args: any[]) => value.call(binding, ...args);
    // Core decorates injectee functions with metadata properties
    for (const key in value) {
      if (value.hasOwnProperty(key)) {
        fn[key] = clone(value[key], binding);
      }
    }
    fn.__rfo = functionToRFO(value).__function;
    return fn;
  }

  if (Array.isArray(value)) {
    return value.map((el) => clone(el, binding));
  }

  // Don't try to clone anything other than plain objects
  if (typeof value === 'object' && value.constructor === Object) {
    const out = {};

    for (const key in value) {
      if (!value.hasOwnProperty(key) || key.slice(0, 2) === '__') {
        continue;
      }

      // If it looks like guest bytecode, don't clone it since
      // (a) we're passing down *our* function binding, which will break event handling and
      // (b) each HaikuComponent#constructor calls clone() on its own anyway
      if (key === 'elementName' && typeof value[key] !== 'string') {
        out[key] = value[key];
      } else {
        out[key] = clone(value[key], binding);
      }
    }

    return out;
  }

  return value;
};

const setStyle = (subkey, element, value) => {
  element.attributes.style[subkey] = value;
};

const setAttribute = (key, element, value) => {
  element.attributes[key] = value;
};

const isNumeric = (n) => {
  return !isNaN(parseFloat(n)) && isFinite(n);
};

const isInteger = (x) => {
  return x % 1 === 0;
};

const REACT_MATCHING_OPTIONS = {
  name: 'type',
  attributes: 'props',
};

const HAIKU_MATCHING_OPTIONS = {
  name: 'elementName',
  attributes: 'attributes',
};

const querySelectSubtree = (surrogate: any, value) => {
  // First try the Haiku format
  if (cssMatchOne(surrogate, value, HAIKU_MATCHING_OPTIONS)) {
    return surrogate;
  }

  // If no match yet, try the React format (TODO: Does this belong here?)
  if (cssMatchOne(surrogate, value, REACT_MATCHING_OPTIONS)) {
    return surrogate;
  }

  // Visit the descendants (if any) and see if we have a match there
  const children = (
    surrogate.children || // Haiku's format
    (surrogate.props && surrogate.props.children) // React's format
  );

  // If no children, we definitely don't have a match in this subtree
  if (!children) {
    return null;
  }

  // Check for arrays first since arrays pass the typeof object check
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const found = querySelectSubtree(children[i], value);

      // First time a match is found, break the loop and return it
      if (found) {
        return found;
      }
    }
  }

  // React may store 'children' as a single object
  if (typeof children === 'object') {
    return querySelectSubtree(children, value);
  }
};

const querySelectSurrogates = (surrogates: any, value: string): any => {
  if (Array.isArray(surrogates)) {
    // Return the first match we locate in the collection
    return surrogates.map((surrogate) => querySelectSurrogates(surrogate, value))[0];
  }

  if (surrogates && typeof surrogates === 'object') {
    return querySelectSubtree(surrogates, value);
  }
};

const selectSurrogate = (surrogates: any, value: any): any => {
  // If the placeholder value is intended as an array index
  if (Array.isArray(surrogates) && isNumeric(value) && isInteger(value)) {
    if (surrogates[value]) {
      return surrogates[value];
    }
  }

  // If the placeholder value is intended as a key
  if (surrogates && typeof surrogates === 'object' && typeof value === 'string') {
    if (surrogates[value]) {
      return surrogates[value];
    }
  }

  return querySelectSurrogates(surrogates, value + '');
};

const getCanonicalPlaybackValue = (value) => {
  if (typeof value !== 'object') {
    return {
      Default: value,
    };
  }

  return value;
};

const controlFlowPlaceholderImpl = (element, surrogate, receiver) => {
  if (element.__surrogate !== surrogate) {
    element.elementName = surrogate.elementName;
    element.children = surrogate.children || [];
    if (surrogate.attributes) {
      if (!element.attributes) {
        element.attributes = {};
      }
      for (const key in surrogate.attributes) {
        if (key === 'haiku-id') {
          continue;
        }
        element.attributes[key] = surrogate.attributes[key];
      }
    }
    element.__surrogate = surrogate;
  }
};

/**
 * 'Vanities' are functions that provide special handling for applied properties.
 * So for example, if a component wants to apply 'foo.bar'=3 to a <div> in its template,
 * the renderer will look in the vanities dictionary to see if there is a
 * vanity 'foo.bar' available, and if so, pass the value 3 into that function.
 * The function, in turn, knows how to apply that value to the virtual element passed into
 * it. In the future these will be defined by components themselves as inputs; for now,
 * we are keeping a whitelist of possible vanity handlers which the renderer directly
 * loads and calls.
 */

export const getVanity = (elementName: string, propertyName: string) => {
  if (elementName) {
    if (VANITIES[elementName] && VANITIES[elementName][propertyName]) {
      return VANITIES[elementName][propertyName];
    }
  }

  return VANITIES['*'][propertyName];
};

export const LAYOUT_3D_VANITIES = {
  // Layout has a couple of special values that relate to display
  // but not to position:
  shown: (_, element, value) => {
    element.layout.shown = value;
  },
  // Opacity needs to have its opacity *layout* property set
  // as opposed to its element attribute so the renderer can make a decision about
  // where to put it based on the rendering medium's rules
  opacity: (_, element, value) => {
    element.layout.opacity = value;
  },

  // Rotation is a special snowflake since it needs to account for
  // the w-component of the quaternion and carry it
  'rotation.x': (name, element, value) => {
    element.layout.rotation.x = value;
  },
  'rotation.y': (name, element, value) => {
    element.layout.rotation.y = value;
  },
  'rotation.z': (name, element, value) => {
    element.layout.rotation.z = value;
  },

  // If you really want to set what we call 'position' then
  // we do so on the element's attributes; this is mainly to
  // enable the x/y positioning system for SVG elements.
  'position.x': (name, element, value) => {
    element.attributes.x = value;
  },
  'position.y': (name, element, value) => {
    element.attributes.y = value;
  },

  // Everything that follows is a standard 3-coord component
  // relating to the element's position in space
  'align.x': (name, element, value) => {
    element.layout.align.x = value;
  },
  'align.y': (name, element, value) => {
    element.layout.align.y = value;
  },
  'align.z': (name, element, value) => {
    element.layout.align.z = value;
  },
  'mount.x': (name, element, value) => {
    element.layout.mount.x = value;
  },
  'mount.y': (name, element, value) => {
    element.layout.mount.y = value;
  },
  'mount.z': (name, element, value) => {
    element.layout.mount.z = value;
  },
  'origin.x': (name, element, value) => {
    element.layout.origin.x = value;
  },
  'origin.y': (name, element, value) => {
    element.layout.origin.y = value;
  },
  'origin.z': (name, element, value) => {
    element.layout.origin.z = value;
  },
  'scale.x': (name, element, value) => {
    element.layout.scale.x = value;
  },
  'scale.y': (name, element, value) => {
    element.layout.scale.y = value;
  },
  'scale.z': (name, element, value) => {
    element.layout.scale.z = value;
  },
  'sizeAbsolute.x': (name, element, value) => {
    element.layout.sizeAbsolute.x = value;
  },
  'sizeAbsolute.y': (name, element, value) => {
    element.layout.sizeAbsolute.y = value;
  },
  'sizeAbsolute.z': (name, element, value) => {
    element.layout.sizeAbsolute.z = value;
  },
  'sizeDifferential.x': (name, element, value) => {
    element.layout.sizeDifferential.x = value;
  },
  'sizeDifferential.y': (name, element, value) => {
    element.layout.sizeDifferential.y = value;
  },
  'sizeDifferential.z': (name, element, value) => {
    element.layout.sizeDifferential.z = value;
  },
  'sizeMode.x': (name, element, value) => {
    element.layout.sizeMode.x = value;
  },
  'sizeMode.y': (name, element, value) => {
    element.layout.sizeMode.y = value;
  },
  'sizeMode.z': (name, element, value) => {
    element.layout.sizeMode.z = value;
  },
  'sizeProportional.x': (name, element, value) => {
    element.layout.sizeProportional.x = value;
  },
  'sizeProportional.y': (name, element, value) => {
    element.layout.sizeProportional.y = value;
  },
  'sizeProportional.z': (name, element, value) => {
    element.layout.sizeProportional.z = value;
  },
  'shear.xy': (name, element, value) => {
    element.layout.shear.xy = value;
  },
  'shear.xz': (name, element, value) => {
    element.layout.shear.xz = value;
  },
  'shear.yz': (name, element, value) => {
    element.layout.shear.yz = value;
  },
  'translation.x': (name, element, value) => {
    element.layout.translation.x = value;
  },
  'translation.y': (name, element, value) => {
    element.layout.translation.y = value;
  },
  'translation.z': (name, element, value) => {
    element.layout.translation.z = value;
  },
};

export const VANITIES = {
  '*': {
    ...LAYOUT_3D_VANITIES,

    // CSS style properties that need special handling
    'style.WebkitTapHighlightColor': (_, element, value) => {
      element.attributes.style.webkitTapHighlightColor = value;
    },

    // Text and other inner-content related vanities
    content: (_, element, value) => {
      element.children = [value + ''];
    },
    children: (_, element, value) => {
      element.children = value;
    },
    insert: (_, element, value) => {
      element.children = [value];
    },

    // Playback-related vanities that involve controlling timeline or clock time
    playback: (
      name,
      element,
      value: any,
      context: HaikuContext,
      timeline: HaikuTimeline,
      receiver: HaikuComponent,
      sender: HaikuComponent,
    ) => {
      const canonicalValue = getCanonicalPlaybackValue(value);

      for (const timelineName in canonicalValue) {
        const timelineInstance = receiver && receiver.getTimeline(timelineName);

        if (timelineInstance) {
          timelineInstance.setPlaybackStatus(canonicalValue[timelineName]);
        }
      }
    },

    // Control-flow vanities that alter the output structure of the component
    'controlFlow.placeholder': (
      name,
      element,
      value,
      context,
      timeline,
      receiver,
      sender,
    ) => {
      if (value === null || value === undefined) {
        return;
      }

      if (typeof value !== 'number' && typeof value !== 'string') {
        return;
      }

      let surrogates;

      // Surrogates can be passed in as:
      //   - React children (an array)
      //   - A React subtree (we'll use query selectors to match)
      //   - A Haiku subtree (we'll use query selectors to match)
      //   - Key/value pairs
      if (context.config.children) {
        surrogates = context.config.children;
        if (!Array.isArray(surrogates)) {
          surrogates = [surrogates];
        }
      } else if (context.config.placeholder) {
        surrogates = context.config.placeholder;
      }

      if (!surrogates) {
        return;
      }

      const surrogate = selectSurrogate(surrogates, value);

      if (surrogate === null || surrogate === undefined) {
        return;
      }

      // If we have a surrogate, then we must clear the children, otherwise we will often
      // see a flash of the default content before the injected content flows in lazily
      element.children = [];

      // If we are running via a framework adapter, allow that framework to provide its own placeholder mechanism.
      // This is necessary e.g. in React where their element format needs to be converted into our 'mana' format
      if (context.config.vanities['controlFlow.placeholder']) {
        context.config.vanities['controlFlow.placeholder'](
          element,
          surrogate,
          value,
          context,
          timeline,
          receiver,
          sender,
        );
      } else {
        controlFlowPlaceholderImpl(element, surrogate, receiver);
      }
    },
  },
};

export const getFallback = (elementName: string, propertyName: string) => {
  if (elementName) {
    if (
      LAYOUT_COORDINATE_SYSTEM_FALLBACKS[elementName] &&
      LAYOUT_COORDINATE_SYSTEM_FALLBACKS[elementName][propertyName] !== undefined) {
      return LAYOUT_COORDINATE_SYSTEM_FALLBACKS[elementName][propertyName];
    }

    if (FALLBACKS[elementName] && FALLBACKS[elementName][propertyName] !== undefined) {
      return FALLBACKS[elementName][propertyName];
    }
  }

  return FALLBACKS['*'][propertyName];
};

const LAYOUT_COORDINATE_SYSTEM_FALLBACKS = {
  svg: {
    'origin.x': 0.5,
    'origin.y': 0.5,
    'origin.z': 0.5,
  },
};

const LAYOUT_DEFAULTS = Layout3D.createLayoutSpec();

export const FALLBACKS = {
  '*': {
    shown: LAYOUT_DEFAULTS.shown,
    opacity: LAYOUT_DEFAULTS.opacity,
    content: null,
    'mount.x': LAYOUT_DEFAULTS.mount.x,
    'mount.y': LAYOUT_DEFAULTS.mount.y,
    'mount.z': LAYOUT_DEFAULTS.mount.z,
    'align.x': LAYOUT_DEFAULTS.align.x,
    'align.y': LAYOUT_DEFAULTS.align.y,
    'align.z': LAYOUT_DEFAULTS.align.z,
    'origin.x': LAYOUT_DEFAULTS.origin.x,
    'origin.y': LAYOUT_DEFAULTS.origin.y,
    'origin.z': LAYOUT_DEFAULTS.origin.z,
    'translation.x': LAYOUT_DEFAULTS.translation.x,
    'translation.y': LAYOUT_DEFAULTS.translation.y,
    'translation.z': LAYOUT_DEFAULTS.translation.z,
    'rotation.x': LAYOUT_DEFAULTS.rotation.x,
    'rotation.y': LAYOUT_DEFAULTS.rotation.y,
    'rotation.z': LAYOUT_DEFAULTS.rotation.z,
    'scale.x': LAYOUT_DEFAULTS.scale.x,
    'scale.y': LAYOUT_DEFAULTS.scale.y,
    'scale.z': LAYOUT_DEFAULTS.scale.z,
    'shear.xy': LAYOUT_DEFAULTS.shear.xy,
    'shear.xz': LAYOUT_DEFAULTS.shear.xz,
    'shear.yz': LAYOUT_DEFAULTS.shear.yz,
    'sizeAbsolute.x': LAYOUT_DEFAULTS.sizeAbsolute.x,
    'sizeAbsolute.y': LAYOUT_DEFAULTS.sizeAbsolute.y,
    'sizeAbsolute.z': LAYOUT_DEFAULTS.sizeAbsolute.z,
    'sizeProportional.x': LAYOUT_DEFAULTS.sizeProportional.x,
    'sizeProportional.y': LAYOUT_DEFAULTS.sizeProportional.y,
    'sizeProportional.z': LAYOUT_DEFAULTS.sizeProportional.z,
    'sizeDifferential.x': LAYOUT_DEFAULTS.sizeDifferential.x,
    'sizeDifferential.y': LAYOUT_DEFAULTS.sizeDifferential.y,
    'sizeDifferential.z': LAYOUT_DEFAULTS.sizeDifferential.z,
    'sizeMode.x': LAYOUT_DEFAULTS.sizeMode.x,
    'sizeMode.y': LAYOUT_DEFAULTS.sizeMode.y,
    'sizeMode.z': LAYOUT_DEFAULTS.sizeMode.z,
    'style.overflowX': 'hidden',
    'style.overflowY': 'hidden',
    'style.zIndex': 1,
    'style.WebkitTapHighlightColor': 'rgba(0,0,0,0)',
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    r: 0,
    cx: 0,
    cy: 0,
    rx: 0,
    ry: 0,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    playback: PlaybackSetting.LOOP,
    'controlFlow.repeat': null,
    'controlFlow.placeholder': null,
  },
};

export const LAYOUT_3D_SCHEMA = {
  shown: 'boolean',
  opacity: 'number',
  'mount.x': 'number',
  'mount.y': 'number',
  'mount.z': 'number',
  'align.x': 'number',
  'align.y': 'number',
  'align.z': 'number',
  'origin.x': 'number',
  'origin.y': 'number',
  'origin.z': 'number',
  'translation.x': 'number',
  'translation.y': 'number',
  'translation.z': 'number',
  'rotation.x': 'number',
  'rotation.y': 'number',
  'rotation.z': 'number',
  'scale.x': 'number',
  'scale.y': 'number',
  'scale.z': 'number',
  'shear.xy': 'number',
  'shear.xz': 'number',
  'shear.yz': 'number',
  'sizeAbsolute.x': 'number',
  'sizeAbsolute.y': 'number',
  'sizeAbsolute.z': 'number',
  'sizeProportional.x': 'number',
  'sizeProportional.y': 'number',
  'sizeProportional.z': 'number',
  'sizeDifferential.x': 'number',
  'sizeDifferential.y': 'number',
  'sizeDifferential.z': 'number',
  'sizeMode.x': 'number',
  'sizeMode.y': 'number',
  'sizeMode.z': 'number',
};
