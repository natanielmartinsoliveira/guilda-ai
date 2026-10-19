import Phaser from 'phaser';
import { t } from '../i18n';
import { type OfficeModel, ROLES, SPOTS, type CrewMember, type GuildRole } from './spots';
import { corridorRoute, type Point, type OfficeLayout } from './layout';
import { themeFor, type OfficeTheme, type RoomPainter } from './themes';
import { plant } from './themes/paint';
import { assignSeats, type Seat } from './seats';
import type { RoomModel, CampusActor } from './campus';
export interface OfficeSelection {
  tenantId: string;
  id: string;
}
interface Actor {
  node: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Image;
  warning: Phaser.GameObjects.Text;
  label?: Phaser.GameObjects.Text;
  stripe?: Phaser.GameObjects.Rectangle;
  member?: CrewMember;
  destination?: Point;
  moving: boolean;
  exiting?: boolean;
  generation: number;
}
/** A room draws in local coordinates. Its root alone translates it into the campus. */
export class RoomView {
  layout: OfficeLayout;
  private theme: OfficeTheme;
  private belt: Phaser.GameObjects.Rectangle[] = [];
  readonly root: Phaser.GameObjects.Container;
  private add: Phaser.GameObjects.GameObjectFactory;
  private members = new Map<string, Actor>();
  private bases = new Map<string, Actor>();
  private placed = new Map<string, Seat>();
  private labels = new Map<string, Phaser.GameObjects.Text>();
  private titles = new Map<string, Phaser.GameObjects.Text>();
  private screens = new Map<string, Phaser.GameObjects.Rectangle>();
  private previousRoom?: string;
  private previousCompleted?: Set<string>;
  private chest?: Phaser.GameObjects.Container;
  private signature?: string;
  private objectCounter = 0;
  constructor(
    private scene: Phaser.Scene,
    public room: RoomModel,
    public offset: Point,
    private campus: boolean,
    private color: string,
    private motionReduced: () => boolean,
    private selected: (pointer: Phaser.Input.Pointer, selection: OfficeSelection) => void,
    private requestCamera: () => void,
  ) {
    this.theme = themeFor(room.theme ?? room.model.theme);
    this.layout = this.theme.layout(room.seats);
    this.root = scene.add.container(offset.x, offset.y).setName(room.tenantId + ':room');
    // Reparent every factory object, including nested actors, without changing the one-room drawing.
    this.add = new Proxy(scene.add, {
      get: (factory, key) => {
        const method = Reflect.get(factory, key);
        return typeof method === 'function'
          ? (...args: unknown[]) => {
              const object = method.apply(factory, args);
              if (object instanceof Phaser.GameObjects.GameObject) {
                object.setName(this.key(String(key) + ':' + this.objectCounter++));
                this.root.add(object);
              }
              return object;
            }
          : method;
      },
    });
    this.drawRoom();
  }
  private get tweens() {
    return this.scene.tweens;
  }
  private get cameras() {
    return this.scene.cameras;
  }
  private get reduced() {
    return this.motionReduced();
  }
  private key(id: string) {
    return this.room.tenantId + ':' + id;
  }
  private select(pointer: Phaser.Input.Pointer, id: string) {
    this.selected(pointer, { tenantId: this.room.tenantId, id });
  }
  setPlacement(offset: Point, color: string) {
    this.offset = offset;
    this.root.setPosition(offset.x, offset.y);
    this.color = color;
    for (const actor of this.members.values())
      actor.stripe?.setFillStyle(Phaser.Display.Color.HexStringToColor(color).color);
  }
  private text(x: number, y: number, value: string, size = 14, color = this.theme.palette.label) {
    return this.add
      .text(x, y, value, {
        fontFamily: 'monospace',
        fontSize: `${size}px`,
        color,
        resolution: 2,
        backgroundColor: this.theme.palette.labelBackground,
        padding: { x: 6, y: 4 },
      })
      .setOrigin(0.5)
      .setDepth(8);
  }
  private rect(x: number, y: number, w: number, h: number, color: number) {
    return this.add.rectangle(x, y, w, h, color).setOrigin(0);
  }
  private painter(): RoomPainter {
    return {
      rect: (x, y, w, h, c) => this.rect(x, y, w, h, c),
      text: (x, y, value, size, color) => this.text(x, y, value, size, color),
      circle: (x, y, r, c, alpha) => this.add.circle(x, y, r, c, alpha),
      polygon: (x, y, points, c) => this.add.polygon(x, y, points, c),
      sprite: (sheet, frame, x, y, scale = 1) => this.add.image(x, y, sheet, frame).setScale(scale),
      zone: (x, y, w, h) => this.add.zone(x, y, w, h),
    };
  }
  private plant(x: number, y: number) {
    plant(this.painter(), x, y, this.theme.id !== 'guild');
  }
  private monitor(x: number, y: number, role: string) {
    this.rect(x - 25, y - 25, 50, 31, 0x252c3a);
    this.rect(x - 20, y - 20, 40, 20, 0x385d58);
    for (let i = 0; i < 3; i++) this.rect(x - 16, y - 16 + i * 5, 22 - i * 4, 2, 0x9bcb9a);
    this.rect(x - 3, y + 6, 6, 6, 0x333340);
    this.screens.set(this.key(role), this.add.rectangle(x + 15, y - 14, 4, 4, 0xaceebc));
  }
  private drawRoom() {
    const {
      width: WIDTH,
      height: HEIGHT,
      stations: STATIONS,
      stationWidth,
      mural,
      waiting,
      planning,
      queue,
      pantry,
      chest,
    } = this.layout;
    const extra = stationWidth - 216;
    const p = this.theme.palette;
    this.rect(0, 0, WIDTH, HEIGHT, p.floor);
    for (let y = 32; y < HEIGHT - 30; y += 24)
      for (let x = 32; x < WIDTH - 30; x += 64) {
        const offset = ((y / 24) % 2) * 32;
        this.rect(Math.max(32, x - offset), y, 62, 22, (x + y) % 3 ? p.plank : p.plankAlt);
        this.rect(Math.max(34, x - offset + 5), y + 17, 30, 1, p.grain);
      }
    for (let x = 0; x < WIDTH; x += 48) {
      this.rect(x, 0, 46, 28, p.wall);
      this.rect(x, HEIGHT - 28, 46, 26, p.wallShade);
    }
    for (let y = 30; y < HEIGHT - 30; y += 32) {
      this.rect(0, y, 28, 30, p.wall);
      this.rect(WIDTH - 28, y, 28, 30, p.wall);
    }
    this.theme.decorate(this.painter(), this.layout);
    this.belt = this.root.list.filter((o) =>
      o.getData('officeBelt'),
    ) as Phaser.GameObjects.Rectangle[];
    for (const segment of this.belt) segment.setData('startX', segment.x);
    this.rect(mural.x - 70, mural.y - 22, 140, 46, p.board);
    this.rect(mural.x - 63, mural.y - 16, 126, 31, p.boardInner);
    for (let i = 0; i < 4; i++) this.rect(mural.x - 53 + i * 28, mural.y - 11, 18, 22, p.paper);
    this.text(
      mural.x,
      mural.y + Number(this.layout.decor.muralLabelOffset ?? 36),
      t('guild.missionBoard'),
      13,
    );
    this.rect(waiting.x - 65, waiting.y - 19, 130, 39, p.waiting);
    this.text(waiting.x, waiting.y, t('status.waiting'), 12, p.waitingText);
    // Collaboration table is between the two aisles; neither crosses it.
    this.rect(planning.x + (336 - 480), planning.y + (281 - 304), 288, 52, p.planningRug);
    this.rect(planning.x + (345 - 480), planning.y + (285 - 304), 270, 44, p.planningRugInner);
    this.rect(planning.x + (382 - 480), planning.y + (291 - 304), 194, 35, p.planningEdge);
    this.rect(planning.x + (387 - 480), planning.y + (287 - 304), 184, 33, p.planningDesk);
    for (const x of [416, 473, 530]) {
      this.rect(planning.x + x - 480, planning.y - 9, 25, 18, 0xe4d3a7);
      this.rect(planning.x + x - 476, planning.y - 4, 16, 2, 0x8a9a83);
    }
    this.text(planning.x, planning.y, t('guild.planningTable'), 12);
    ROLES.forEach((role) => {
      const { x, y } = STATIONS[role];
      this.rect(x - stationWidth / 2, y - 52, stationWidth, 108, p.rug);
      this.rect(x - stationWidth / 2 + 4, y - 48, stationWidth - 8, 100, p.rugInner);
      this.rect(x - 73 - extra / 2, y - 20, 146 + extra, 43, p.deskEdge);
      this.rect(x - 70 - extra / 2, y - 23, 140 + extra, 37, p.desk);
      this.rect(x - 63 - extra / 2, y + 16, 10, 13, p.deskEdge);
      this.rect(x + 53 + extra / 2, y + 16, 10, 13, p.deskEdge);
      if (role === 'coder' || role === 'guard') {
        this.monitor(x - 30, y - 12, role);
        this.monitor(x + 30, y - 12, role + '2');
      }
      if (role === 'architect') {
        this.plant(x - 57, y - 12);
        this.rect(x - 15, y - 28, 56, 35, 0xe3d1a7);
        this.rect(x - 8, y - 22, 35, 2, 0x648274);
        this.rect(x + 7, y - 22, 2, 22, 0x648274);
      }
      if (role === 'tester') {
        this.monitor(x - 33, y - 12, role);
        this.rect(x + 12, y - 30, 34, 33, 0xe5d8b5);
        for (let i = 0; i < 3; i++) {
          this.rect(x + 17, y - 24 + i * 8, 5, 5, 0x63906c);
          this.rect(x + 26, y - 23 + i * 8, 15, 2, 0x867962);
        }
      }
      if (role === 'fixer') {
        this.rect(x - 45, y - 33, 80, 27, 0x4a4c54);
        for (let i = 0; i < 4; i++) {
          this.rect(x - 33 + i * 18, y - 26, 4, 21, 0xb9bdc3);
          this.rect(x - 37 + i * 18, y - 27, 12, 5, 0xb9bdc3);
        }
        this.rect(x + 48, y - 15, 16, 22, 0x627a6b);
      }
      if (role === 'reviewer') {
        for (let i = 0; i < 3; i++)
          this.rect(x - 46 + i * 24, y - 29, 20, 30, [0x72598b, 0xb5a780, 0xe6d5ae][i]);
        this.add.circle(x + 42, y - 21, 10, 0xb6c7c4);
        this.add.circle(x + 42, y - 21, 6, 0x627a6b);
        this.rect(x + 47, y - 14, 5, 14, 0x403442);
      }
      if (role === 'guard') {
        this.add.polygon(x + 88, y - 8, [0, -14, 12, -9, 10, 7, 0, 16, -10, 7, -12, -9], 0xa3c39e);
        this.add.polygon(x + 88, y - 8, [0, -9, 7, -6, 6, 5, 0, 10, -6, 5, -7, -6], 0x416852);
      }
      this.titles.set(this.key('@' + role), this.text(x, y - 70, SPOTS[role].label, 15));
      this.labels.set(this.key('@' + role), this.text(x, y + 97, t('app.loading'), 12));
      this.add
        .zone(x, y, stationWidth - 6, 105)
        .setInteractive({ useHandCursor: true })
        .on('pointerup', (p: Phaser.Input.Pointer) => this.select(p, '@' + role));
    });
    this.rect(pantry.x - 120, pantry.y - 40, 210, 25, p.sofa);
    this.rect(pantry.x - 120, pantry.y - 50, 210, 14, p.sofaBack);
    this.rect(pantry.x + 99, pantry.y - 39, 40, 28, p.coffee);
    this.rect(pantry.x + 99, pantry.y - 43, 40, 8, p.coffeeTop);
    this.rect(pantry.x + 111, pantry.y - 59, 12, 14, p.coffeeCup);
    this.text(pantry.x, pantry.y, t('guild.pantryLong'), 12);
    this.rect(queue.x - 76, queue.y - 8, 153, 26, p.queue);
    for (let i = 0; i < 4; i++) this.rect(queue.x - 67 + i * 34, queue.y - 3, 25, 14, p.queuePaper);
    this.text(queue.x, queue.y + 31, t('guild.taskQueue'), 12);
    this.chest = this.add.container(chest.x, chest.y, [
      this.add.rectangle(0, 0, 68, 34, p.chest),
      this.add.rectangle(0, -14, 72, 8, p.chestLid),
      this.add.rectangle(0, 0, 9, 14, p.chestLatch),
    ]);
    this.text(
      chest.x,
      chest.y + 32,
      t(this.theme.id === 'guild' ? 'guild.deliveryChest' : 'guild.deliveryBox'),
      12,
    );
    this.chest
      .setSize(85, 46)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', (p: Phaser.Input.Pointer) => this.select(p, '@delivery'));
    this.add
      .zone(mural.x, mural.y, 140, 65)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', (p: Phaser.Input.Pointer) => this.select(p, '@mural'));
    this.add
      .zone(waiting.x, waiting.y, 135, 46)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', (p: Phaser.Input.Pointer) => this.select(p, '@waiting'));
    this.add
      .zone(queue.x, queue.y, 155, 40)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', (p: Phaser.Input.Pointer) => this.select(p, '@queue'));
  }
  private makeActor(point: Point, role: GuildRole, member?: CrewMember): Actor {
    const sprite = this.add.image(0, 0, 'people', this.layout.stations[role].frame).setScale(2);
    const warning = this.add
      .text(12, -23, '!', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: this.theme.palette.status.waiting,
        backgroundColor: this.theme.palette.labelBackground,
      })
      .setVisible(false);
    const node = this.add
      .container(point.x, point.y, [this.add.ellipse(0, 12, 25, 8, 0x362d38, 0.5), sprite, warning])
      .setDepth(9)
      .setName(this.key(member ? member.id : '@' + role));
    let label: Phaser.GameObjects.Text | undefined;
    if (member) {
      label = this.text(0, -30, member.key, 11);
      node.add(label);
    }
    node
      .setSize(40, 42)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', (pointer: Phaser.Input.Pointer) =>
        this.select(pointer, member ? member.taskId : '@' + role),
      );
    const stripe =
      this.campus && label
        ? this.add.rectangle(
            0,
            0,
            label.width,
            3,
            Phaser.Display.Color.HexStringToColor(this.color).color,
          )
        : undefined;
    if (stripe) node.add(stripe);
    return { node, sprite, warning, label, stripe, member, moving: false, generation: 0 };
  }
  private destroyActor(actor: Actor) {
    actor.generation++;
    this.tweens.killTweensOf(actor.node);
    this.tweens.killTweensOf(actor.sprite);
    actor.node.destroy();
  }
  private walk(actor: Actor, dest: Point, done?: () => void, snap = false) {
    if (!snap && actor.destination?.x === dest.x && actor.destination.y === dest.y) return;
    actor.destination = dest;
    const generation = ++actor.generation;
    this.tweens.killTweensOf(actor.node);
    if (this.reduced || snap || (actor.node.x === dest.x && actor.node.y === dest.y)) {
      actor.node.setPosition(dest.x, dest.y);
      actor.moving = false;
      done?.();
      return;
    }
    const points = corridorRoute({ x: actor.node.x, y: actor.node.y }, dest, this.layout);
    actor.moving = points.length > 0;
    const next = () => {
      if (generation !== actor.generation) return;
      const p = points.shift();
      if (!p) {
        actor.moving = false;
        done?.();
        this.requestCamera();
        return;
      }
      this.tweens.add({
        targets: actor.node,
        x: p.x,
        y: p.y,
        duration: Math.max(
          60,
          Phaser.Math.Distance.Between(actor.node.x, actor.node.y, p.x, p.y) * 4,
        ),
        onComplete: next,
      });
    };
    next();
    this.requestCamera();
  }
  private work(actor: Actor) {
    this.tweens.killTweensOf(actor.sprite);
    actor.sprite.y = 0;
    if (actor.member?.tone === 'working' && !actor.exiting && !this.reduced)
      this.tweens.add({ targets: actor.sprite, y: -2, duration: 600, yoyo: true, repeat: -1 });
  }
  apply(room: RoomModel, force = false) {
    const model = room.model;
    const signature = JSON.stringify(model);
    this.room = room;
    const theme = themeFor(room.theme ?? model.theme);
    const themeChanged = theme.id !== this.theme.id;
    if (!force && this.signature === signature && this.layout.seats === room.seats && !themeChanged)
      return;
    this.signature = signature;
    if (!model.guild || model.loaded === false) return;
    const roomChanged = this.previousRoom === undefined;
    const rebuild = roomChanged || this.layout.seats !== room.seats || themeChanged;
    if (rebuild) {
      this.stopOwned();
      this.members.clear();
      this.bases.clear();
      this.placed.clear();
      this.labels.clear();
      this.titles.clear();
      this.screens.clear();
      this.root.removeAll(true);
      this.theme = theme;
      this.layout = theme.layout(room.seats);
      this.drawRoom();
      if (roomChanged) this.previousCompleted = undefined;
      this.previousRoom = this.room.tenantId;
    }
    const assignment = assignSeats(model.crew, this.placed, this.layout.seats);
    this.placed = assignment.placed;
    const ids = new Set(model.crew.map((m) => m.id));
    for (const [id, actor] of this.members) {
      if (assignment.placed.has(actor.member!.id)) continue;
      if (ids.has(actor.member!.id)) {
        this.destroyActor(actor);
        this.members.delete(id);
        continue;
      }
      if (this.reduced) {
        this.destroyActor(actor);
        this.members.delete(id);
        continue;
      }
      if (actor.exiting) continue;
      actor.exiting = true;
      const delivered = model.guild.completed.includes(actor.member!.taskId);
      this.walk(actor, delivered ? this.layout.delivery : this.layout.exit, () => {
        this.tweens.add({
          targets: actor.node,
          alpha: 0,
          duration: 300,
          onComplete: () => {
            this.destroyActor(actor);
            this.members.delete(id);
            this.requestCamera();
          },
        });
      });
    }
    for (const member of model.crew) {
      const place = this.placed.get(member.id);
      if (!place) continue;
      const dest = this.layout.stations[place.role].seats[place.seat];
      let actor = this.members.get(this.key(member.id));
      const fresh = !actor;
      if (!actor) {
        actor = this.makeActor(rebuild ? dest : this.layout.entrance, member.role, member);
        this.members.set(this.key(member.id), actor);
      }
      actor.member = member;
      if (actor.exiting) {
        actor.exiting = false;
        actor.destination = undefined;
        actor.node.setAlpha(1);
      }
      actor.warning
        .setText(member.tone === 'waiting' ? '◷' : '!')
        .setVisible(member.tone !== 'working')
        .setColor(this.theme.palette.status[member.tone]);
      actor.label?.setColor(this.theme.palette.status[member.tone]);
      this.tweens.killTweensOf(actor.sprite);
      actor.sprite.y = 0;
      const current = actor;
      this.walk(
        actor,
        dest,
        () => {
          current.sprite.setFrame(this.layout.stations[current.member!.role].frame);
          this.work(current);
        },
        rebuild || (fresh && this.previousCompleted === undefined),
      );
      if (!actor.moving) this.work(actor);
    }
    model.guild.agents.forEach((agent, index) => {
      const hasMembers = model.crew.some((m) => m.role === agent.role);
      const base = this.bases.get(this.key('@' + agent.role));
      if (hasMembers && base) {
        this.destroyActor(base);
        this.bases.delete(this.key('@' + agent.role));
      } else if (!hasMembers) {
        const rest = this.layout.rest[index];
        const actor = base ?? this.makeActor(this.layout.stations[agent.role].seats[0], agent.role);
        this.bases.set(this.key('@' + agent.role), actor);
        this.walk(
          actor,
          rest,
          undefined,
          rebuild || (!base && this.previousCompleted === undefined),
        );
      }
      const more = assignment.overflow[agent.role];
      this.titles
        .get(this.key('@' + agent.role))!
        .setText(SPOTS[agent.role].label + (more ? ` +${more}` : ''));
      this.labels
        .get(this.key('@' + agent.role))!
        .setText(
          `${agent.tone === 'working' ? '◆' : agent.tone === 'error' ? '!' : agent.tone === 'waiting' ? '◷' : '○'} ${agent.status}${agent.tasks.length > 1 ? ' · ' + agent.tasks.length : ''}`,
        )
        .setColor(this.theme.palette.status[agent.tone]);
      const working = model.crew.some((m) => m.role === agent.role && m.tone === 'working');
      for (const key of [agent.role, agent.role + '2']) {
        const screen = this.screens.get(this.key(key));
        if (!screen) continue;
        this.tweens.killTweensOf(screen);
        screen.setAlpha(working ? 1 : 0.35);
        if (working && !this.reduced)
          this.tweens.add({
            targets: screen,
            alpha: 0.35,
            duration: 850,
            yoyo: true,
            repeat: -1,
          });
      }
    });
    if (
      this.previousCompleted &&
      model.guild.completed.some((id) => !this.previousCompleted!.has(id)) &&
      !this.reduced
    )
      this.tweens.add({
        targets: this.chest,
        scaleX: 1.12,
        scaleY: 1.12,
        duration: 250,
        yoyo: true,
        repeat: 2,
      });
    this.animateDecorations();
    this.previousCompleted = new Set(model.guild.completed);
    this.requestCamera();
    this.readableLabels();
  }
  private animateDecorations() {
    if (!this.belt.length || (!this.reduced && this.tweens.getTweensOf(this.belt[0]).length))
      return;
    this.tweens.killTweensOf(this.belt);
    for (const segment of this.belt) segment.x = segment.getData('startX');
    if (!this.reduced) this.tweens.add({ targets: this.belt, x: '+=8', duration: 650, repeat: -1 });
  }
  private readableLabels() {
    const zoom = this.cameras.main.zoom;
    for (const [id, actor] of this.members)
      if (actor.label) {
        const seat = this.placed.get(actor.member!.id)?.seat ?? 0;
        actor.label.setScale(1 / zoom).setPosition(0, (-26 - (seat % 4) * 15) / zoom);
        actor.stripe
          ?.setScale(1 / zoom)
          .setPosition(0, actor.label.y + (actor.label.height / 2 + 2) / zoom);
      }
  }

  targets(): CampusActor[] {
    return [...this.members.values()].map((a) => ({
      tenantId: this.room.tenantId,
      x: a.node.x,
      y: a.node.y,
      moving: a.moving,
      working: !a.exiting && a.member?.tone === 'working',
    }));
  }
  focusPoint(taskId: string): Point | undefined {
    const actor = [...this.members.values()].find((a) => a.member?.taskId === taskId && !a.exiting);
    const member = this.room.model.crew.find((m) => m.taskId === taskId);
    return actor
      ? { x: actor.node.x, y: actor.node.y }
      : member
        ? this.layout.stations[member.role].seats[0]
        : undefined;
  }
  tick() {
    this.readableLabels();
  }
  private stopOwned() {
    if (this.belt.length) this.tweens.killTweensOf(this.belt);
    for (const actor of [...this.members.values(), ...this.bases.values()]) {
      actor.generation++;
      this.tweens.killTweensOf(actor.node);
      this.tweens.killTweensOf(actor.sprite);
    }
    for (const screen of this.screens.values()) this.tweens.killTweensOf(screen);
    if (this.chest) this.tweens.killTweensOf(this.chest);
  }
  stopMotion() {
    this.stopOwned();
    this.chest?.setScale(1);
    for (const actor of [...this.members.values(), ...this.bases.values()]) {
      actor.destination = undefined;
      actor.sprite.y = 0;
      actor.moving = false;
    }
    this.apply(this.room, true);
  }
  destroy() {
    this.stopOwned();
    this.root.destroy(true);
    this.members.clear();
    this.bases.clear();
  }
}
