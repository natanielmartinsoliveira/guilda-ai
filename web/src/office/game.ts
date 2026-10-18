import { t } from '../i18n';
import Phaser from 'phaser';
import { type OfficeModel, ROLES, SPOTS, type CrewMember, type GuildRole } from './spots';
import { officeLayout, corridorRoute, type Point } from './layout';
import { assignSeats, type Seat } from './seats';
import { cameraFocus, type CameraMode, type Focus } from './camera';
export interface OfficeView {
  update(model: OfficeModel): void;
  setCameraMode(mode: CameraMode): void;
  zoomBy(factor: number): void;
  focus(taskId: string): void;
  onCameraModeChange(cb: (mode: CameraMode) => void): void;
  destroy(): void;
}
interface Actor {
  node: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Image;
  warning: Phaser.GameObjects.Text;
  label?: Phaser.GameObjects.Text;
  member?: CrewMember;
  destination?: Point;
  moving: boolean;
  exiting?: boolean;
  generation: number;
}
const COLORS = { working: '#a9efbc', waiting: '#ffe09c', error: '#ffadad', idle: '#d6c7ee' };
export function createOffice(parent: HTMLElement, onSelect: (id: string) => void): OfficeView {
  let latest: OfficeModel | undefined, scene: GuildScene | undefined;
  let mode: CameraMode = 'follow',
    modeChanged: ((mode: CameraMode) => void) | undefined;
  let pendingFocus: string | undefined;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = media.matches;
  class GuildScene extends Phaser.Scene {
    private layout = officeLayout(1);
    private members = new Map<string, Actor>();
    private bases = new Map<GuildRole, Actor>();
    private placed = new Map<string, Seat>();
    private labels = new Map<GuildRole, Phaser.GameObjects.Text>();
    private titles = new Map<GuildRole, Phaser.GameObjects.Text>();
    private screens = new Map<string, Phaser.GameObjects.Rectangle>();
    private previousRoom?: string;
    private previousCompleted?: Set<string>;
    private chest?: Phaser.GameObjects.Container;
    private target?: Focus;
    private cameraAt = 0;
    private starts = new Map<number, Point>();
    private dragged = false;
    private pinchDistance = 0;
    constructor() {
      super('guild');
    }
    preload() {
      this.load.spritesheet('people', '/app/assets/office/dungeon.png', {
        frameWidth: 16,
        frameHeight: 16,
      });
    }
    create() {
      this.layout = officeLayout(latest?.seats ?? 1);
      const camera = this.cameras.main;
      const clampX = camera.clampX.bind(camera),
        clampY = camera.clampY.bind(camera);
      // Phaser pins undersized worlds to the top-left; keep overview letterboxing centered.
      camera.clampX = (x) =>
        camera.displayWidth >= this.layout.width
          ? (this.layout.width - camera.width) / 2
          : clampX(x);
      camera.clampY = (y) =>
        camera.displayHeight >= this.layout.height
          ? (this.layout.height - camera.height) / 2
          : clampY(y);
      this.drawRoom();
      this.controls();
      this.scale.on('resize', () => {
        const camera = this.cameras.main;
        const min = Math.min(
          this.scale.width / this.layout.width,
          this.scale.height / this.layout.height,
        );
        camera.setZoom(Phaser.Math.Clamp(camera.zoom, min, Math.max(2.5, min)));
        this.target = undefined;
        this.updateCamera(false);
      });
      scene = this;
      if (latest) this.apply(latest);
      if (pendingFocus) this.focusMember(pendingFocus);
    }
    private text(x: number, y: number, value: string, size = 14, color = '#fff2d9') {
      return this.add
        .text(x, y, value, {
          fontFamily: 'monospace',
          fontSize: `${size}px`,
          color,
          resolution: 2,
          backgroundColor: '#30293c',
          padding: { x: 6, y: 4 },
        })
        .setOrigin(0.5)
        .setDepth(8);
    }
    private rect(x: number, y: number, w: number, h: number, color: number) {
      return this.add.rectangle(x, y, w, h, color).setOrigin(0);
    }
    private plant(x: number, y: number) {
      this.rect(x - 10, y, 20, 18, 0x9c6455);
      this.rect(x - 15, y - 22, 30, 22, 0x365f48);
      this.rect(x - 8, y - 34, 16, 34, 0x648e59);
      this.rect(x + 3, y - 25, 13, 12, 0x8ba86a);
    }
    private bookcase(x: number, y: number) {
      this.rect(x, y, 78, 38, 0x382c29);
      for (let i = 0; i < 9; i++)
        this.rect(x + 5 + i * 8, y + 5, 5, 23, [0x8a6999, 0x62856c, 0xc09d6a][i % 3]);
      this.rect(x, y + 30, 78, 6, 0xa07b54);
    }
    private monitor(x: number, y: number, role: string) {
      this.rect(x - 25, y - 25, 50, 31, 0x252c3a);
      this.rect(x - 20, y - 20, 40, 20, 0x385d58);
      for (let i = 0; i < 3; i++) this.rect(x - 16, y - 16 + i * 5, 22 - i * 4, 2, 0x9bcb9a);
      this.rect(x - 3, y + 6, 6, 6, 0x333340);
      this.screens.set(role, this.add.rectangle(x + 15, y - 14, 4, 4, 0xaceebc));
    }
    private drawRoom() {
      const {
        width: WIDTH,
        height: HEIGHT,
        stations: STATIONS,
        stationWidth,
        plants,
        lamps,
        windows,
        bookcases,
        mural,
        waiting,
        planning,
        queue,
        pantry,
        chest,
        doors,
      } = this.layout;
      const extra = stationWidth - 216;
      this.cameras.main.setBounds(0, 0, WIDTH, HEIGHT);
      this.rect(0, 0, WIDTH, HEIGHT, 0x383542);
      for (let y = 32; y < HEIGHT - 30; y += 24)
        for (let x = 32; x < WIDTH - 30; x += 64) {
          const offset = ((y / 24) % 2) * 32;
          this.rect(Math.max(32, x - offset), y, 62, 22, (x + y) % 3 ? 0x866045 : 0x916b4d);
          this.rect(Math.max(34, x - offset + 5), y + 17, 30, 1, 0xa67c56);
        }
      for (let x = 0; x < WIDTH; x += 48) {
        this.rect(x, 0, 46, 28, 0x5d5864);
        this.rect(x, HEIGHT - 28, 46, 26, 0x504b57);
      }
      for (let y = 30; y < HEIGHT - 30; y += 32) {
        this.rect(0, y, 28, 30, 0x5d5864);
        this.rect(WIDTH - 28, y, 28, 30, 0x5d5864);
      }
      for (const { x } of windows) {
        this.rect(x - 20, 39, 40, 53, 0x352d43);
        this.rect(x - 15, 44, 30, 42, 0x768d91);
        this.rect(x - 2, 44, 4, 42, 0xc3a274);
        this.rect(x - 15, 62, 30, 4, 0xc3a274);
      }
      for (const { x, y } of lamps) {
        this.add.circle(x, y, 40, 0xffc676, 0.08);
        this.rect(x - 6, y - 8, 12, 20, 0xdfb069);
        this.rect(x - 3, y - 12, 6, 12, 0xffe6a3);
      }
      for (const { x, y } of plants) this.plant(x, y);
      for (const p of bookcases) this.bookcase(p.x, p.y);
      for (const p of doors) this.rect(p.x - 14, p.y - 14, 28, 28, 0x352d43);
      this.rect(mural.x - 70, mural.y - 22, 140, 46, 0x503c30);
      this.rect(mural.x - 63, mural.y - 16, 126, 31, 0xbe9c70);
      for (let i = 0; i < 4; i++) this.rect(mural.x - 53 + i * 28, mural.y - 11, 18, 22, 0xe8d5a5);
      this.text(mural.x, mural.y + 36, t('guild.missionBoard'), 13);
      this.rect(waiting.x - 65, waiting.y - 19, 130, 39, 0x645077);
      this.text(waiting.x, waiting.y, t('status.waiting'), 12, '#ffe0a6');
      // Collaboration table is between the two aisles; neither crosses it.
      this.rect(planning.x + (336 - 480), planning.y + (281 - 304), 288, 52, 0x674d77);
      this.rect(planning.x + (345 - 480), planning.y + (285 - 304), 270, 44, 0x856493);
      this.rect(planning.x + (382 - 480), planning.y + (291 - 304), 194, 35, 0x4e342b);
      this.rect(planning.x + (387 - 480), planning.y + (287 - 304), 184, 33, 0xb48a5b);
      for (const x of [416, 473, 530]) {
        this.rect(planning.x + x - 480, planning.y - 9, 25, 18, 0xe4d3a7);
        this.rect(planning.x + x - 476, planning.y - 4, 16, 2, 0x8a9a83);
      }
      this.text(planning.x, planning.y, t('guild.planningTable'), 12);
      ROLES.forEach((role) => {
        const { x, y } = STATIONS[role];
        this.rect(x - stationWidth / 2, y - 52, stationWidth, 108, 0x594750);
        this.rect(x - stationWidth / 2 + 4, y - 48, stationWidth - 8, 100, 0x756078);
        this.rect(x - 73 - extra / 2, y - 20, 146 + extra, 43, 0x493329);
        this.rect(x - 70 - extra / 2, y - 23, 140 + extra, 37, 0xb08a60);
        this.rect(x - 63 - extra / 2, y + 16, 10, 13, 0x493329);
        this.rect(x + 53 + extra / 2, y + 16, 10, 13, 0x493329);
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
          this.add.polygon(
            x + 88,
            y - 8,
            [0, -14, 12, -9, 10, 7, 0, 16, -10, 7, -12, -9],
            0xa3c39e,
          );
          this.add.polygon(x + 88, y - 8, [0, -9, 7, -6, 6, 5, 0, 10, -6, 5, -7, -6], 0x416852);
        }
        this.titles.set(role, this.text(x, y - 70, SPOTS[role].label, 15));
        this.labels.set(role, this.text(x, y + 97, t('app.loading'), 12));
        this.add
          .zone(x, y, stationWidth - 6, 105)
          .setInteractive({ useHandCursor: true })
          .on('pointerup', (p: Phaser.Input.Pointer) => this.select(p, '@' + role));
      });
      this.rect(pantry.x - 120, pantry.y - 40, 210, 25, 0x4b6558);
      this.rect(pantry.x - 120, pantry.y - 50, 210, 14, 0x78967e);
      this.rect(pantry.x + 99, pantry.y - 39, 40, 28, 0x53382d);
      this.rect(pantry.x + 99, pantry.y - 43, 40, 8, 0xb28758);
      this.rect(pantry.x + 111, pantry.y - 59, 12, 14, 0xe5cf9d);
      this.text(pantry.x, pantry.y, t('guild.pantryLong'), 12);
      this.rect(queue.x - 76, queue.y - 8, 153, 26, 0x513d30);
      for (let i = 0; i < 4; i++) this.rect(queue.x - 67 + i * 34, queue.y - 3, 25, 14, 0xd9c49b);
      this.text(queue.x, queue.y + 31, t('guild.taskQueue'), 12);
      this.chest = this.add.container(chest.x, chest.y, [
        this.add.rectangle(0, 0, 68, 34, 0x7c5338),
        this.add.rectangle(0, -14, 72, 8, 0xd6ad62),
        this.add.rectangle(0, 0, 9, 14, 0xe1c475),
      ]);
      this.text(chest.x, chest.y + 32, t('guild.deliveryChest'), 12);
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
    private select(pointer: Phaser.Input.Pointer, id: string) {
      const start = this.starts.get(pointer.id);
      if (
        !this.dragged &&
        start &&
        Phaser.Math.Distance.Between(start.x, start.y, pointer.x, pointer.y) <= 6
      )
        onSelect(id);
    }
    private makeActor(point: Point, role: GuildRole, member?: CrewMember): Actor {
      const sprite = this.add.image(0, 0, 'people', this.layout.stations[role].frame).setScale(2);
      const warning = this.add
        .text(12, -23, '!', {
          fontFamily: 'monospace',
          fontSize: '14px',
          color: COLORS.waiting,
          backgroundColor: '#30293c',
        })
        .setVisible(false);
      const node = this.add
        .container(point.x, point.y, [
          this.add.ellipse(0, 12, 25, 8, 0x362d38, 0.5),
          sprite,
          warning,
        ])
        .setDepth(9);
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
      return { node, sprite, warning, label, member, moving: false, generation: 0 };
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
      if (reduced || snap) {
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
          this.updateCamera();
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
      this.updateCamera();
    }
    private work(actor: Actor) {
      this.tweens.killTweensOf(actor.sprite);
      actor.sprite.y = 0;
      if (actor.member?.tone === 'working' && !actor.exiting && !reduced)
        this.tweens.add({ targets: actor.sprite, y: -2, duration: 600, yoyo: true, repeat: -1 });
    }
    apply(model: OfficeModel) {
      if (!model.guild || model.loaded === false) return;
      const roomChanged = model.roomKey !== this.previousRoom;
      const rebuild = roomChanged || this.layout.seats !== (model.seats ?? 1);
      if (rebuild) {
        this.tweens.killAll();
        this.starts.clear();
        this.dragged = true;
        this.members.clear();
        this.bases.clear();
        this.placed.clear();
        this.labels.clear();
        this.titles.clear();
        this.screens.clear();
        this.children.removeAll(true);
        this.layout = officeLayout(model.seats ?? 1);
        this.drawRoom();
        this.target = undefined;
        if (roomChanged) this.previousCompleted = undefined;
        this.previousRoom = model.roomKey;
      }
      const assignment = assignSeats(model.crew, this.placed, this.layout.seats);
      this.placed = assignment.placed;
      const ids = new Set(model.crew.map((m) => m.id));
      for (const [id, actor] of this.members) {
        if (assignment.placed.has(id)) continue;
        if (ids.has(id)) {
          this.destroyActor(actor);
          this.members.delete(id);
          continue;
        }
        if (reduced) {
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
              this.updateCamera();
            },
          });
        });
      }
      for (const member of model.crew) {
        const place = this.placed.get(member.id);
        if (!place) continue;
        const dest = this.layout.stations[place.role].seats[place.seat];
        let actor = this.members.get(member.id);
        const fresh = !actor;
        if (!actor) {
          actor = this.makeActor(rebuild ? dest : this.layout.entrance, member.role, member);
          this.members.set(member.id, actor);
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
          .setColor(COLORS[member.tone]);
        actor.label?.setColor(COLORS[member.tone]);
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
        const base = this.bases.get(agent.role);
        if (hasMembers && base) {
          this.destroyActor(base);
          this.bases.delete(agent.role);
        } else if (!hasMembers) {
          const rest = this.layout.rest[index];
          const actor =
            base ?? this.makeActor(this.layout.stations[agent.role].seats[0], agent.role);
          this.bases.set(agent.role, actor);
          this.walk(
            actor,
            rest,
            undefined,
            rebuild || (!base && this.previousCompleted === undefined),
          );
        }
        const more = assignment.overflow[agent.role];
        this.titles.get(agent.role)!.setText(SPOTS[agent.role].label + (more ? ` +${more}` : ''));
        this.labels
          .get(agent.role)!
          .setText(
            `${agent.tone === 'working' ? '◆' : agent.tone === 'error' ? '!' : agent.tone === 'waiting' ? '◷' : '○'} ${agent.status}${agent.tasks.length > 1 ? ' · ' + agent.tasks.length : ''}`,
          )
          .setColor(COLORS[agent.tone]);
        const working = model.crew.some((m) => m.role === agent.role && m.tone === 'working');
        for (const key of [agent.role, agent.role + '2']) {
          const screen = this.screens.get(key);
          if (!screen) continue;
          this.tweens.killTweensOf(screen);
          screen.setAlpha(working ? 1 : 0.35);
          if (working && !reduced)
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
        !reduced
      )
        this.tweens.add({
          targets: this.chest,
          scaleX: 1.12,
          scaleY: 1.12,
          duration: 250,
          yoyo: true,
          repeat: 2,
        });
      this.previousCompleted = new Set(model.guild.completed);
      this.updateCamera(!rebuild);
      this.readableLabels();
    }
    private viewSize() {
      return { width: this.scale.width, height: this.scale.height };
    }
    setMode(next: CameraMode) {
      mode = next;
      modeChanged?.(mode);
      this.target = undefined;
      this.cameras.main.panEffect.reset();
      this.cameras.main.zoomEffect.reset();
      if (mode !== 'manual') this.updateCamera();
    }
    private applyFocus(focus: Focus, animate = true) {
      const camera = this.cameras.main;
      if (animate && !reduced) {
        camera.pan(focus.x, focus.y, 600, 'Sine.easeInOut', true);
        camera.zoomTo(focus.zoom, 600, 'Sine.easeInOut', true);
      } else {
        camera.panEffect.reset();
        camera.zoomEffect.reset();
        camera.setZoom(focus.zoom).centerOn(focus.x, focus.y);
      }
      this.target = focus;
    }
    private updateCamera(animate = true) {
      if (mode === 'manual') return;
      const active = [...this.members.values()];
      const walking = active.filter((a) => a.moving);
      const points =
        mode === 'overview'
          ? []
          : (walking.length
              ? walking
              : active.filter((a) => !a.exiting && a.member?.tone === 'working')
            ).map((a) => ({ x: a.node.x, y: a.node.y }));
      const focus = cameraFocus(points, this.viewSize(), this.layout);
      if (
        this.target &&
        Math.hypot(focus.x - this.target.x, focus.y - this.target.y) < 24 &&
        Math.abs(focus.zoom / this.target.zoom - 1) < 0.05
      )
        return;
      this.applyFocus(focus, animate);
    }
    private readableLabels() {
      const zoom = this.cameras.main.zoom;
      for (const [id, actor] of this.members)
        if (actor.label) {
          const seat = this.placed.get(id)?.seat ?? 0;
          actor.label.setScale(1 / zoom).setPosition(0, (-26 - (seat % 4) * 15) / zoom);
        }
    }
    update(time: number) {
      this.readableLabels();
      if (
        !reduced &&
        mode === 'follow' &&
        time - this.cameraAt >= 400 &&
        [...this.members.values()].some((a) => a.moving)
      ) {
        this.cameraAt = time;
        this.updateCamera();
      }
    }
    zoom(factor: number, point?: Point) {
      this.setMode('manual');
      const camera = this.cameras.main;
      const offset = point
        ? { x: point.x - camera.x - camera.width / 2, y: point.y - camera.y - camera.height / 2 }
        : undefined;
      const anchor = offset
        ? {
            x: camera.scrollX + camera.width / 2 + offset.x / camera.zoom,
            y: camera.scrollY + camera.height / 2 + offset.y / camera.zoom,
          }
        : undefined;
      const min = Math.min(
        this.scale.width / this.layout.width,
        this.scale.height / this.layout.height,
      );
      camera.setZoom(Phaser.Math.Clamp(camera.zoom * factor, min, Math.max(2.5, min)));
      if (offset && anchor) {
        camera.scrollX = anchor.x - camera.width / 2 - offset.x / camera.zoom;
        camera.scrollY = anchor.y - camera.height / 2 - offset.y / camera.zoom;
      }
      this.readableLabels();
    }
    focusMember(taskId: string) {
      this.setMode('manual');
      const actor = [...this.members.values()].find(
        (a) => a.member?.taskId === taskId && !a.exiting,
      );
      const member = latest?.crew.find((m) => m.taskId === taskId);
      const point = actor
        ? { x: actor.node.x, y: actor.node.y }
        : member
          ? this.layout.stations[member.role].seats[0]
          : undefined;
      if (point)
        this.applyFocus(
          cameraFocus([point], this.viewSize(), this.layout, { minZoom: 1.5 }),
          !reduced,
        );
    }
    private pan(dx: number, dy: number) {
      this.setMode('manual');
      const c = this.cameras.main;
      c.scrollX -= dx / c.zoom;
      c.scrollY -= dy / c.zoom;
    }
    private controls() {
      this.input.addPointer(1);
      this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
        if (!this.input.manager.pointers.some((other) => other !== p && other.isDown))
          this.dragged = false;
        this.starts.set(p.id, { x: p.x, y: p.y });
        this.pinchDistance = 0;
      });
      this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
        if (!p.isDown) return;
        const touches = this.input.manager.pointers.filter((t) => t.isDown && t.wasTouch);
        if (touches.length >= 2) {
          const distance = Phaser.Math.Distance.Between(
            touches[0].x,
            touches[0].y,
            touches[1].x,
            touches[1].y,
          );
          if (this.pinchDistance)
            this.zoom(distance / this.pinchDistance, {
              x: (touches[0].x + touches[1].x) / 2,
              y: (touches[0].y + touches[1].y) / 2,
            });
          this.pinchDistance = distance;
          this.dragged = true;
          return;
        }
        const start = this.starts.get(p.id);
        if (start && Phaser.Math.Distance.Between(start.x, start.y, p.x, p.y) > 6)
          this.dragged = true;
        if (this.dragged) this.pan(p.x - p.prevPosition.x, p.y - p.prevPosition.y);
      });
      this.input.on(
        'wheel',
        (p: Phaser.Input.Pointer, _objects: unknown, _dx: number, dy: number) => {
          this.zoom(Math.exp(-dy * 0.001), p);
        },
      );
    }
    keyboard(event: KeyboardEvent) {
      const pan: Record<string, Point> = {
        ArrowLeft: { x: 48, y: 0 },
        ArrowRight: { x: -48, y: 0 },
        ArrowUp: { x: 0, y: 48 },
        ArrowDown: { x: 0, y: -48 },
      };
      if (pan[event.key]) {
        event.preventDefault();
        this.pan(pan[event.key].x, pan[event.key].y);
      } else if (['+', '=', '-'].includes(event.key)) {
        event.preventDefault();
        this.zoom(event.key === '-' ? 1 / 1.2 : 1.2);
      }
    }
    stopMotion() {
      const focus = this.target;
      this.cameras.main.panEffect.reset();
      this.cameras.main.zoomEffect.reset();
      this.tweens.killAll();
      this.chest?.setScale(1);
      for (const actor of [...this.members.values(), ...this.bases.values()]) {
        actor.destination = undefined;
        actor.sprite.y = 0;
        actor.moving = false;
      }
      this.target = undefined;
      if (latest) this.apply(latest);
      if (mode === 'manual' && focus) this.applyFocus(focus, false);
    }
  }
  const changed = () => {
    reduced = media.matches;
    scene?.stopMotion();
  };
  const keyboard = (event: KeyboardEvent) => scene?.keyboard(event);
  const region = parent.parentElement;
  media.addEventListener('change', changed);
  region?.addEventListener('keydown', keyboard);
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    pixelArt: true,
    backgroundColor: '#30293c',
    banner: false,
    audio: { noAudio: true },
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: parent.clientWidth || 960,
      height: parent.clientHeight || 640,
    },
    scene: GuildScene,
  });
  return {
    update(model) {
      latest = model;
      scene?.apply(model);
    },
    setCameraMode(next) {
      if (scene) scene.setMode(next);
      else {
        mode = next;
        modeChanged?.(mode);
      }
    },
    zoomBy(factor) {
      scene?.zoom(factor);
    },
    focus(taskId) {
      pendingFocus = taskId;
      scene?.focusMember(taskId);
    },
    onCameraModeChange(cb) {
      modeChanged = cb;
      cb(mode);
    },
    destroy() {
      media.removeEventListener('change', changed);
      region?.removeEventListener('keydown', keyboard);
      modeChanged = undefined;
      scene = undefined;
      game.destroy(true);
    },
  };
}
