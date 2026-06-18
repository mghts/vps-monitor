import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useI18n } from './i18n';

export type GlobeNodeMember = {
  id: string;
  name: string;
  online: boolean;
  isCenter?: boolean;
  city?: string;
  region?: string;
  country?: string;
  ipMasked?: string;
};

export type GlobeNode = {
  id: string;
  name: string;
  online: boolean;
  isCenter?: boolean;
  status?: 'online' | 'offline' | 'mixed';
  latitude: number;
  longitude: number;
  city?: string;
  region?: string;
  country?: string;
  ipMasked?: string;
  members?: GlobeNodeMember[];
};

type Props = {
  nodes: GlobeNode[];
  theme: 'dark' | 'light';
  center?: {
    latitude: number;
    longitude: number;
    name: string;
    city?: string;
    region?: string;
    country?: string;
    ipMasked?: string;
  } | null;
  onSelectNode?: (nodeId: string) => void;
};

export type GlobeMapHandle = {
  resetView: () => void;
};

function latLngToVector(latitude: number, longitude: number, radius: number) {
  const phi = (90 - latitude) * Math.PI / 180;
  const theta = (longitude + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

function indexFromId(id: string) {
  return [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0);
}

function globeStatusColor(status: GlobeNode['status'], online: boolean, theme: 'dark' | 'light') {
  if (status === 'offline' || !online) return theme === 'light' ? 0xd97974 : 0xe58b83;
  if (status === 'mixed') return theme === 'light' ? 0xd79a4d : 0xe0ba72;
  return theme === 'light' ? 0x74ad82 : 0x9ec989;
}

function globeLineColor(status: GlobeNode['status'], online: boolean, theme: 'dark' | 'light') {
  if (status === 'offline' || !online) return theme === 'light' ? 0xd97974 : 0xe58b83;
  if (status === 'mixed') return theme === 'light' ? 0xd79a4d : 0xe0ba72;
  return theme === 'light' ? 0x6aa8a5 : 0x8ddad2;
}

function createArc(start: THREE.Vector3, end: THREE.Vector3, color: number) {
  const startUnit = start.clone().normalize();
  const endUnit = end.clone().normalize();
  const dot = THREE.MathUtils.clamp(startUnit.dot(endUnit), -1, 1);
  const angle = Math.acos(dot);
  const sinAngle = Math.sin(angle);
  const altitude = 0.012 + Math.min(0.028, angle * 0.014);
  const surfacePoints = Array.from({ length: 97 }, (_, index) => {
    const t = index / 96;
    const aWeight = sinAngle < 0.0001 ? 1 - t : Math.sin((1 - t) * angle) / sinAngle;
    const bWeight = sinAngle < 0.0001 ? t : Math.sin(t * angle) / sinAngle;
    return startUnit.clone()
      .multiplyScalar(aWeight)
      .add(endUnit.clone().multiplyScalar(bWeight))
      .normalize()
      .multiplyScalar(1.006);
  });
  const points = surfacePoints.map((point, index) =>
    point.clone().normalize().multiplyScalar(1.022 + Math.sin(Math.PI * index / 96) * altitude)
  );
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
  const surfaceCurve = new THREE.CatmullRomCurve3(surfacePoints, false, 'centripetal', 0.5);
  const group = new THREE.Group();
  const glow = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 96, 0.009, 6, false),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      depthTest: true
    })
  );
  const core = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 96, 0.0026, 6, false),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      depthTest: true
    })
  );
  const hiddenPath = new THREE.Mesh(
    new THREE.TubeGeometry(surfaceCurve, 96, 0.0012, 5, false),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      depthTest: false
    })
  );
  glow.renderOrder = 3;
  core.renderOrder = 4;
  hiddenPath.renderOrder = 2;
  group.add(glow, core, hiddenPath);
  return { group, curve };
}

function createCylinderBetween(start: THREE.Vector3, end: THREE.Vector3, radius: number, color: number, opacity: number) {
  const direction = end.clone().sub(start);
  const length = direction.length();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 8),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true
    })
  );
  mesh.position.copy(start.clone().add(end).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.renderOrder = 6;
  return mesh;
}

function createBreakMarker(position: THREE.Vector3, color: number) {
  const outward = position.clone().normalize();
  let tangentA = new THREE.Vector3(0, 1, 0).cross(outward);
  if (tangentA.lengthSq() < 0.001) {
    tangentA = new THREE.Vector3(1, 0, 0).cross(outward);
  }
  tangentA.normalize();
  const tangentB = outward.clone().cross(tangentA).normalize();
  const group = new THREE.Group();
  const basis = new THREE.Matrix4().makeBasis(tangentA, tangentB, outward);
  const width = 0.013;
  const height = 0.022;
  group.position.copy(position.clone().multiplyScalar(1.004));
  group.quaternion.setFromRotationMatrix(basis);
  group.add(
    createCylinderBetween(new THREE.Vector3(-width, -height, 0), new THREE.Vector3(-width * 0.1, height, 0), 0.0028, color, 0.82),
    createCylinderBetween(new THREE.Vector3(width * 0.1, -height, 0), new THREE.Vector3(width, height, 0), 0.0028, color, 0.82)
  );
  group.renderOrder = 6;
  return group;
}

function centeredQuaternion(latitude: number, longitude: number) {
  const outward = latLngToVector(latitude, longitude, 1).normalize();
  const north = new THREE.Vector3(0, 1, 0)
    .sub(outward.clone().multiplyScalar(outward.y))
    .normalize();
  const east = north.clone().cross(outward).normalize();
  const basis = new THREE.Matrix4().makeBasis(east, north, outward).transpose();
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

const GlobeMap = forwardRef<GlobeMapHandle, Props>(function GlobeMap({ nodes, center, theme, onSelectNode }, ref) {
  const { t } = useI18n();
  const mountRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<() => void>(() => undefined);
  const onSelectNodeRef = useRef(onSelectNode);
  const viewStateRef = useRef<{
    globeQuaternion: THREE.Quaternion;
    cameraPosition: THREE.Vector3;
    controlsTarget: THREE.Vector3;
  } | null>(null);
  const pinnedRef = useRef(false);
  const markerMaterialsRef = useRef(new Map<string, THREE.MeshBasicMaterial>());
  const [selected, setSelected] = useState<GlobeNode | null>(null);
  const [selectionPinned, setSelectionPinned] = useState(false);
  const [failed, setFailed] = useState(false);
  const geometryKey = useMemo(
    () => [
      center ? `${center.latitude}:${center.longitude}:${center.name}:${center.city || ''}:${center.region || ''}:${center.country || ''}:${center.ipMasked || ''}` : 'no-center',
      theme,
      ...nodes.map((node) => `${node.id}:${node.online}:${node.status || ''}:${node.isCenter || false}:${node.latitude}:${node.longitude}:${node.name}:${node.city || ''}:${node.region || ''}:${node.country || ''}:${node.ipMasked || ''}:${node.members?.map((member) => `${member.id}:${member.name}:${member.online}:${member.isCenter || false}:${member.ipMasked || ''}`).join(',') || ''}`)
    ].join('|'),
    [center?.latitude, center?.longitude, center?.name, center?.city, center?.region, center?.country, center?.ipMasked, nodes, theme]
  );

  useEffect(() => {
    onSelectNodeRef.current = onSelectNode;
  }, [onSelectNode]);

  useImperativeHandle(ref, () => ({
    resetView: () => resetRef.current()
  }), []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let frame = 0;
    let disposed = false;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, 3.8);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const globeGroup = new THREE.Group();
    scene.add(globeGroup);

    const texture = new THREE.TextureLoader().load(
      theme === 'light' ? '/assets/earth-light-equirectangular.png' : '/assets/earth-dark-equirectangular.png',
      () => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
      },
      undefined,
      () => setFailed(true)
    );
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 64),
      new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.88,
        metalness: 0.05,
        color: theme === 'light' ? 0xf0eadb : 0xcbbf9f
      })
    );
    globeGroup.add(globe);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.018, 96, 64),
      new THREE.MeshBasicMaterial({
        color: theme === 'light' ? 0x8dbfba : 0x7dc9c2,
        transparent: true,
        opacity: theme === 'light' ? 0.11 : 0.055,
        side: THREE.BackSide
      })
    );
    globeGroup.add(atmosphere);

    scene.add(new THREE.AmbientLight(theme === 'light' ? 0xfff8e8 : 0xded1b5, theme === 'light' ? 2 : 1.45));
    const keyLight = new THREE.DirectionalLight(theme === 'light' ? 0xfffbef : 0xf0e5cf, theme === 'light' ? 2.2 : 2.5);
    keyLight.position.set(-2, 2, 3);
    scene.add(keyLight);

    const nodeMeshes: Array<THREE.Mesh & { userData: { node?: GlobeNode } }> = [];
    const flowParticles: Array<{
      mesh: THREE.Mesh;
      curve: THREE.CatmullRomCurve3;
      offset: number;
      speed: number;
    }> = [];
    markerMaterialsRef.current.clear();
    const centerPosition = center
      ? latLngToVector(center.latitude, center.longitude, 1.018)
      : null;

    if (centerPosition) {
      const centerMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.043, 24, 24),
        new THREE.MeshBasicMaterial({ color: theme === 'light' ? 0x4ea3a1 : 0x7dc9c2 })
      ) as THREE.Mesh & { userData: { node?: GlobeNode } };
      centerMarker.position.copy(centerPosition);
      if (!nodes.some((node) => node.isCenter)) {
        centerMarker.userData.node = {
          id: '__center__',
          name: center.name,
          online: true,
          isCenter: true,
          latitude: center.latitude,
          longitude: center.longitude,
          city: center.city,
          region: center.region,
          country: center.country,
          ipMasked: center.ipMasked,
          members: []
        };
        nodeMeshes.push(centerMarker);
      }
      globeGroup.add(centerMarker);

      const centerCore = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 18, 18),
        new THREE.MeshBasicMaterial({ color: theme === 'light' ? 0xfffdf6 : 0xefe6d2 })
      );
      centerCore.position.copy(centerPosition.clone().multiplyScalar(1.002));
      globeGroup.add(centerCore);

      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.06, 0.082, 36),
        new THREE.MeshBasicMaterial({
          color: theme === 'light' ? 0x4ea3a1 : 0x7dc9c2,
          transparent: true,
          opacity: 0.52,
          side: THREE.DoubleSide
        })
      );
      halo.position.copy(centerPosition.clone().multiplyScalar(1.006));
      halo.lookAt(centerPosition.clone().multiplyScalar(2));
      globeGroup.add(halo);

      const outerHalo = new THREE.Mesh(
        new THREE.RingGeometry(0.095, 0.103, 42),
        new THREE.MeshBasicMaterial({
          color: theme === 'light' ? 0x4ea3a1 : 0x7dc9c2,
          transparent: true,
          opacity: 0.28,
          side: THREE.DoubleSide
        })
      );
      outerHalo.position.copy(centerPosition.clone().multiplyScalar(1.007));
      outerHalo.lookAt(centerPosition.clone().multiplyScalar(2));
      globeGroup.add(outerHalo);
    }

    nodes.forEach((node) => {
      const position = latLngToVector(node.latitude, node.longitude, 1.025);
      const status = node.status || (node.online ? 'online' : 'offline');
      const memberCount = node.members?.length || 1;
      const markerMaterial = new THREE.MeshBasicMaterial({
        color: globeStatusColor(status, node.online, theme)
      });
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(Math.min(0.036, (status === 'offline' ? 0.028 : 0.022) + Math.max(0, memberCount - 1) * 0.0035), 18, 18),
        markerMaterial
      ) as THREE.Mesh & { userData: { node?: GlobeNode } };
      marker.position.copy(position);
      marker.userData.node = node;
      nodeMeshes.push(marker);
      markerMaterialsRef.current.set(node.id, markerMaterial);
      globeGroup.add(marker);

      if (centerPosition && node.id !== 'center' && centerPosition.angleTo(position) > 0.01) {
        const color = globeLineColor(status, node.online, theme);
        const arc = createArc(centerPosition, position, color);
        globeGroup.add(arc.group);
        if (status !== 'offline') {
          [0, 0.42].forEach((offset, particleIndex) => {
            const particle = new THREE.Mesh(
              new THREE.SphereGeometry(particleIndex === 0 ? 0.011 : 0.007, 12, 12),
              new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: particleIndex === 0 ? 0.95 : 0.58,
                depthWrite: false,
                depthTest: false
              })
            );
            particle.renderOrder = 5;
            globeGroup.add(particle);
            flowParticles.push({
              mesh: particle,
              curve: arc.curve,
              offset: offset + (indexFromId(node.id) % 7) * 0.08,
              speed: 0.045 + (indexFromId(node.id) % 5) * 0.005
            });
          });
        } else {
          [0.34, 0.58, 0.78].forEach((ratio) => {
            globeGroup.add(createBreakMarker(arc.curve.getPointAt(ratio), color));
          });
        }
      }
    });

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.enablePan = false;
    controls.minDistance = 1.75;
    controls.maxDistance = 5;
    controls.rotateSpeed = 0.34;
    controls.zoomSpeed = 0.55;
    controls.autoRotate = false;

    const resetView = () => {
      const focus = center || nodes[0] || { latitude: 20, longitude: 105 };
      globeGroup.quaternion.copy(centeredQuaternion(focus.latitude, focus.longitude));
      camera.position.set(0, 0, 3.8);
      controls.target.set(0, 0, 0);
      controls.update();
    };
    resetRef.current = resetView;
    if (viewStateRef.current) {
      globeGroup.quaternion.copy(viewStateRef.current.globeQuaternion);
      camera.position.copy(viewStateRef.current.cameraPosition);
      controls.target.copy(viewStateRef.current.controlsTarget);
    } else {
      resetView();
    }
    controls.update();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pointedNode = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(nodeMeshes, false)[0]?.object.userData.node || null;
    };
    let hoveredNodeId = '';
    const handlePointerMove = (event: PointerEvent) => {
      if (pinnedRef.current) return;
      const node = pointedNode(event);
      renderer.domElement.style.cursor = node ? 'pointer' : 'grab';
      const nextNodeId = node?.id || '';
      if (nextNodeId !== hoveredNodeId) {
        hoveredNodeId = nextNodeId;
        setSelected(node);
      }
    };
    const handlePointerLeave = () => {
      if (pinnedRef.current) return;
      renderer.domElement.style.cursor = 'grab';
      hoveredNodeId = '';
      setSelected(null);
    };
    const handlePointer = (event: PointerEvent) => {
      const node = pointedNode(event);
      if (!node) {
        pinnedRef.current = false;
        setSelectionPinned(false);
        setSelected(null);
        return;
      }
      const members = node.members || [];
      if (members.length > 1) {
        pinnedRef.current = true;
        setSelectionPinned(true);
        setSelected(node);
      } else if (node.isCenter && members.length === 0) {
        pinnedRef.current = true;
        setSelectionPinned(true);
        setSelected(node);
      } else {
        onSelectNodeRef.current?.(members[0]?.id || node.id);
      }
    };
    renderer.domElement.style.cursor = 'grab';
    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerleave', handlePointerLeave);
    renderer.domElement.addEventListener('pointerdown', handlePointer);

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    const timer = new THREE.Timer();
    timer.connect(document);
    const animate = (timestamp = performance.now()) => {
      if (disposed) return;
      timer.update(timestamp);
      const elapsed = timer.getElapsed();
      flowParticles.forEach((particle) => {
        const progress = (elapsed * particle.speed + particle.offset) % 1;
        const inwardProgress = Math.min(0.999999, 1 - progress);
        particle.mesh.position.copy(particle.curve.getPointAt(inwardProgress));
      });
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      disposed = true;
      viewStateRef.current = {
        globeQuaternion: globeGroup.quaternion.clone(),
        cameraPosition: camera.position.clone(),
        controlsTarget: controls.target.clone()
      };
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('pointerleave', handlePointerLeave);
      renderer.domElement.removeEventListener('pointerdown', handlePointer);
      controls.dispose();
      timer.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      texture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      markerMaterialsRef.current.clear();
    };
  }, [geometryKey]);

  useEffect(() => {
    nodes.forEach((node) => {
      markerMaterialsRef.current.get(node.id)?.color.setHex(
        globeStatusColor(node.status || (node.online ? 'online' : 'offline'), node.online, theme)
      );
    });
    setSelected((current) => {
      const next = current?.id === '__center__' && center
        ? {
            id: '__center__',
            name: center.name,
            online: true,
            isCenter: true,
            latitude: center.latitude,
            longitude: center.longitude,
            city: center.city,
            region: center.region,
            country: center.country,
            ipMasked: center.ipMasked,
            members: []
          }
        : current
          ? nodes.find((node) => node.id === current.id) || null
          : null;
      if (!next) {
        pinnedRef.current = false;
        setSelectionPinned(false);
      }
      return next;
    });
  }, [center, nodes, theme]);

  function closeSelection() {
    pinnedRef.current = false;
    setSelectionPinned(false);
    setSelected(null);
  }

  return (
    <div className="globe-stage">
      <div ref={mountRef} className="globe-canvas" />
      {failed && <div className="map-empty">{t('三维地球纹理加载失败')}</div>}
      {!nodes.length && !center && !failed && <div className="globe-empty">{t('等待具有经纬度的节点接入')}</div>}
      {selected && (
        <div className="globe-popover">
          {selectionPinned && <button className="globe-popover-close" onClick={closeSelection}>×</button>}
          <b>{selected.name}</b>
          <span>{[selected.city, selected.region, selected.country].filter(Boolean).join(' · ') || t('未知位置')}</span>
          {selected.isCenter && (
            <span className="center-node-note">
              {selected.members?.length ? t('同时也是中心节点') : t('中心节点')}
            </span>
          )}
          {selected.members && selected.members.length > 1 ? (
            <div className="globe-node-picker">
              {selected.members.map((member) => (
                <button key={member.id} onClick={() => onSelectNodeRef.current?.(member.id)}>
                  <i className={member.online ? 'online' : 'offline'} />
                  <span>{member.name}</span>
                  <small>{member.ipMasked || t('IP 待上报')}{member.isCenter ? ` · ${t('中心节点')}` : ''}</small>
                </button>
              ))}
            </div>
          ) : (
            <>
              <span>IP：{selected.members?.[0]?.ipMasked || selected.ipMasked || t('IP 待上报')}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
});

export default GlobeMap;
