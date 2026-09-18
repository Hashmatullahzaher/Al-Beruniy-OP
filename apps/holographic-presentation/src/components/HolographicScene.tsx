import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { PresentationScene, GestureState } from '../types/presentation';
import { BLUEPRINT_MODULES, RELATIONSHIP_EDGES } from '../data/enterpriseTopology';

interface HolographicSceneProps {
  currentScene: PresentationScene;
  selectedNodeId: string | null;
  onNodeSelect: (nodeId: string | null) => void;
  gestureState: GestureState;
  freeExploreMode: boolean;
  onFpsUpdate?: (fps: number) => void;
}

export const HolographicScene: React.FC<HolographicSceneProps> = ({
  currentScene,
  selectedNodeId,
  onNodeSelect,
  gestureState,
  freeExploreMode: _freeExploreMode,
  onFpsUpdate
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  // Mesh registries for interaction
  const nodeMeshesRef = useRef<Map<string, THREE.Group>>(new Map());
  const edgeCurvesRef = useRef<Map<string, { curve: THREE.Curve<THREE.Vector3>; particles: THREE.Points; type: string }>>(new Map());
  const aiCoreGroupRef = useRef<THREE.Group | null>(null);
  const aiExplodedGroupRef = useRef<THREE.Group | null>(null);
  const boundaryLineRef = useRef<THREE.Line | null>(null);

  // Interaction & Camera Target
  const targetCamPos = useRef<THREE.Vector3>(new THREE.Vector3(...currentScene.cameraPosition));
  const targetCamLookAt = useRef<THREE.Vector3>(new THREE.Vector3(...currentScene.cameraTarget));
  const currentCamLookAt = useRef<THREE.Vector3>(new THREE.Vector3(...currentScene.cameraTarget));

  // Mouse / Pointer Controls
  const isDragging = useRef(false);
  const prevMousePos = useRef({ x: 0, y: 0 });
  const orbitAngle = useRef({ theta: 0, phi: 0 });
  const hoveredNodeIdRef = useRef<string | null>(null);
  const raycaster = useRef(new THREE.Raycaster());
  const mouseVec = useRef(new THREE.Vector2());

  // Update camera target when scene changes
  useEffect(() => {
    targetCamPos.current.set(...currentScene.cameraPosition);
    targetCamLookAt.current.set(...currentScene.cameraTarget);
  }, [currentScene]);

  // Handle Scene Initialization
  useEffect(() => {
    if (!containerRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    // 1. Scene setup
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color(0x030712);
    scene.fog = new THREE.FogExp2(0x030712, 0.035);

    // 2. Camera setup
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    camera.position.set(...currentScene.cameraPosition);
    cameraRef.current = camera;

    // 3. Renderer setup
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 4. Ambient & Directional Lights
    const ambientLight = new THREE.AmbientLight(0x00f0ff, 0.4);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    const centerPointLight = new THREE.PointLight(0x00f0ff, 2.5, 15);
    centerPointLight.position.set(0, 0, 1);
    scene.add(centerPointLight);

    const finPointLight = new THREE.PointLight(0xf59e0b, 1.8, 12);
    finPointLight.position.set(0, -2.4, 1.5);
    scene.add(finPointLight);

    // 5. Holographic Floor Grid & Radar Rings
    createHolographicGrid(scene);

    // 6. Enterprise Perimeter Firewall Boundary
    createFirewallBoundary(scene);

    // 7. Central AI Core Model
    createAICoreModel(scene);

    // 8. Build all 26 Blueprint 3D Nodes
    createBlueprintNodes(scene);

    // 9. Build Directed Animated Edge Conduits
    createRelationshipEdges(scene);

    // 10. Ambient Space Dust Particles
    createSpaceDust(scene);

    // Animation Loop Variables
    let frameCount = 0;
    let lastFpsTime = performance.now();
    let animId: number;
    const clock = new THREE.Clock();

    const animate = () => {
      animId = requestAnimationFrame(animate);
      clock.getDelta();
      const elapsedTime = clock.getElapsedTime();

      // FPS Calculation
      frameCount++;
      const now = performance.now();
      if (now - lastFpsTime >= 1000) {
        if (onFpsUpdate) onFpsUpdate(frameCount);
        frameCount = 0;
        lastFpsTime = now;
      }

      // Smooth Camera Lerping toward target
      camera.position.lerp(targetCamPos.current, 0.05);
      currentCamLookAt.current.lerp(targetCamLookAt.current, 0.05);
      camera.lookAt(currentCamLookAt.current);

      // Rotate AI Core Gyroscope Rings
      if (aiCoreGroupRef.current) {
        aiCoreGroupRef.current.rotation.y = elapsedTime * 0.4;
        const ring1 = aiCoreGroupRef.current.getObjectByName('ring1');
        const ring2 = aiCoreGroupRef.current.getObjectByName('ring2');
        const coreMesh = aiCoreGroupRef.current.getObjectByName('coreIcosa');
        if (ring1) ring1.rotation.x = elapsedTime * 0.6;
        if (ring2) ring2.rotation.z = -elapsedTime * 0.5;
        if (coreMesh) coreMesh.rotation.y = elapsedTime * 0.8;
      }

      // Exploded AI Core layers (Scene 09)
      if (aiExplodedGroupRef.current) {
        const isScene9 = currentScene.id === 9;
        aiExplodedGroupRef.current.visible = isScene9;
        if (isScene9) {
          aiExplodedGroupRef.current.rotation.y = elapsedTime * 0.15;
        }
      }

      // Pulse and Animate Edge Particles along curves
      edgeCurvesRef.current.forEach(({ curve, particles, type }) => {
        const positions = particles.geometry.attributes.position.array as Float32Array;
        const count = positions.length / 3;
        const speed = type === 'financial' ? 0.35 : type === 'ai_tool' ? 0.45 : 0.25;

        for (let i = 0; i < count; i++) {
          let t = (elapsedTime * speed + i / count) % 1;
          const pt = curve.getPoint(t);
          positions[i * 3] = pt.x;
          positions[i * 3 + 1] = pt.y;
          positions[i * 3 + 2] = pt.z;
        }
        particles.geometry.attributes.position.needsUpdate = true;
      });

      // Animate Node Idle Float & Selection State
      nodeMeshesRef.current.forEach((group, id) => {
        const isFocused = currentScene.focusedNodes.includes(id) || selectedNodeId === id;
        const isSelected = selectedNodeId === id;
        const baseZ = group.userData.baseZ || 0;

        // Dimming factor
        let targetOpacity = 1.0;
        if (currentScene.dimSurrounding && !isFocused) {
          targetOpacity = 0.18;
        }

        // Float motion
        const floatOffset = Math.sin(elapsedTime * 1.5 + group.position.x * 0.5) * 0.06;
        group.position.z = THREE.MathUtils.lerp(
          group.position.z,
          isSelected ? baseZ + 1.2 : baseZ + floatOffset,
          0.08
        );

        // Adjust opacity of children meshes
        group.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            const mat = child.material as THREE.MeshStandardMaterial;
            if (mat.transparent) {
              mat.opacity = THREE.MathUtils.lerp(mat.opacity, targetOpacity, 0.08);
            }
          }
        });
      });

      // Raycasting for Mouse and Gesture Reticle
      performRaycasting();

      renderer.render(scene, camera);
    };

    animate();

    // Window Resize Handler
    const handleResize = () => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animId);
      renderer.dispose();
      if (containerRef.current && renderer.domElement) {
        containerRef.current.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Raycasting for Hover & Node Detection
  const performRaycasting = () => {
    if (!cameraRef.current || !sceneRef.current) return;

    // Use gesture pointer if active, else mouse
    let pointerX = mouseVec.current.x;
    let pointerY = mouseVec.current.y;

    if (gestureState.isTracking && gestureState.activeGesture !== 'none') {
      pointerX = gestureState.cursorScreenPos.x * 2 - 1;
      pointerY = -(gestureState.cursorScreenPos.y * 2 - 1);
    }

    raycaster.current.setFromCamera(new THREE.Vector2(pointerX, pointerY), cameraRef.current);

    const interactiveObjects: THREE.Object3D[] = [];
    nodeMeshesRef.current.forEach((group) => {
      group.traverse((child) => {
        if (child instanceof THREE.Mesh && child.name === 'hitArea') {
          interactiveObjects.push(child);
        }
      });
    });

    const intersects = raycaster.current.intersectObjects(interactiveObjects, false);

    if (intersects.length > 0) {
      const hitNodeId = intersects[0].object.userData.nodeId;
      if (hoveredNodeIdRef.current !== hitNodeId) {
        hoveredNodeIdRef.current = hitNodeId;
        // Subtle scale bump on hovered
        const group = nodeMeshesRef.current.get(hitNodeId);
        if (group) group.scale.set(1.15, 1.15, 1.15);
      }
    } else {
      if (hoveredNodeIdRef.current) {
        const prevGroup = nodeMeshesRef.current.get(hoveredNodeIdRef.current);
        if (prevGroup) prevGroup.scale.set(1.0, 1.0, 1.0);
        hoveredNodeIdRef.current = null;
      }
    }
  };

  // -------------------------------------------------------------
  // THREE.JS SCENE BUILDERS
  // -------------------------------------------------------------

  const createHolographicGrid = (scene: THREE.Scene) => {
    // 1. Concentric Holographic Rings
    const ringRadii = [3, 6, 9, 12, 15];
    ringRadii.forEach((r) => {
      const ringGeo = new THREE.RingGeometry(r - 0.02, r + 0.02, 64);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x00f0ff,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -4.5;
      scene.add(ring);
    });

    // 2. Rectangular Architectural Grid Lines
    const gridHelper = new THREE.GridHelper(32, 32, 0x00f0ff, 0x1e3a8a);
    gridHelper.position.y = -4.5;
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.15;
    scene.add(gridHelper);
  };

  const createFirewallBoundary = (scene: THREE.Scene) => {
    // Semi-circular boundary curve separating Enterprise Internal from External
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(7, -5, -0.8),
      new THREE.Vector3(7.5, 0, -1.0),
      new THREE.Vector3(3, 6.5, -1.2)
    );
    const points = curve.getPoints(50);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
      color: 0xef4444,
      dashSize: 0.4,
      gapSize: 0.25,
      transparent: true,
      opacity: 0.65
    });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    boundaryLineRef.current = line;
    scene.add(line);
  };

  const createAICoreModel = (scene: THREE.Scene) => {
    const aiGroup = new THREE.Group();
    aiGroup.position.set(0, 0, 0);

    // 1. Central Icosahedron Crystal
    const icoGeo = new THREE.IcosahedronGeometry(0.85, 1);
    const icoMat = new THREE.MeshStandardMaterial({
      color: 0x00f0ff,
      emissive: 0x0088ff,
      emissiveIntensity: 0.85,
      wireframe: true,
      transparent: true,
      opacity: 0.9
    });
    const icoMesh = new THREE.Mesh(icoGeo, icoMat);
    icoMesh.name = 'coreIcosa';
    aiGroup.add(icoMesh);

    // Inner Solid Glow Sphere
    const sphereGeo = new THREE.SphereGeometry(0.45, 32, 32);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.85 });
    const innerSphere = new THREE.Mesh(sphereGeo, sphereMat);
    aiGroup.add(innerSphere);

    // 2. Orbiting Gyroscope Rings
    const ring1Geo = new THREE.TorusGeometry(1.2, 0.02, 16, 64);
    const ring1Mat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.6 });
    const ring1 = new THREE.Mesh(ring1Geo, ring1Mat);
    ring1.name = 'ring1';
    aiGroup.add(ring1);

    const ring2Geo = new THREE.TorusGeometry(1.4, 0.02, 16, 64);
    const ring2Mat = new THREE.MeshBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.5 });
    const ring2 = new THREE.Mesh(ring2Geo, ring2Mat);
    ring2.name = 'ring2';
    aiGroup.add(ring2);

    aiCoreGroupRef.current = aiGroup;
    scene.add(aiGroup);

    // 3. Exploded Architecture Layers for Scene 09
    const explodedGroup = new THREE.Group();
    explodedGroup.position.set(0, 0, 0);
    explodedGroup.visible = false;

    // Layer 1: Model Gateway (Top)
    const gwPlate = createLayerPlate('Model Gateway (Multi-LLM)', 0x8b5cf6, 1.8);
    gwPlate.position.set(0, 1.8, 0);
    explodedGroup.add(gwPlate);

    // Layer 2: AI Orchestrator & Agents (Middle-High)
    const orchPlate = createLayerPlate('AI Orchestrator Runtime', 0x00f0ff, 1.6);
    orchPlate.position.set(0, 0.7, 0);
    explodedGroup.add(orchPlate);

    // Layer 3: Enterprise Knowledge Plane (Center)
    const knPlate = createLayerPlate('Enterprise Knowledge Plane', 0x3b82f6, 2.0);
    knPlate.position.set(0, -0.4, 0);
    explodedGroup.add(knPlate);

    // Layer 4: Typed Tool Registry (Lower)
    const toolPlate = createLayerPlate('Governed Typed Tools Registry', 0x10b981, 1.8);
    toolPlate.position.set(0, -1.5, 0);
    explodedGroup.add(toolPlate);

    aiExplodedGroupRef.current = explodedGroup;
    scene.add(explodedGroup);
  };

  const createLayerPlate = (_label: string, color: number, size: number) => {
    const group = new THREE.Group();
    const geo = new THREE.CylinderGeometry(size, size, 0.08, 32);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.65,
      wireframe: true
    });
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
    return group;
  };

  const createBlueprintNodes = (scene: THREE.Scene) => {
    BLUEPRINT_MODULES.forEach((mod) => {
      // Don't duplicate AI Core mesh since it has its custom gyro
      if (mod.id === 'ai_core') {
        const hitArea = new THREE.Mesh(
          new THREE.SphereGeometry(1.2, 16, 16),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
        );
        hitArea.name = 'hitArea';
        hitArea.userData = { nodeId: 'ai_core' };
        aiCoreGroupRef.current?.add(hitArea);
        nodeMeshesRef.current.set('ai_core', aiCoreGroupRef.current!);
        return;
      }

      const group = new THREE.Group();
      group.position.set(...mod.position3D);
      group.userData = { baseZ: mod.position3D[2], nodeId: mod.id };

      const col = new THREE.Color(mod.color);

      // Distinct 3D Geometry based on nodeType
      let nodeMesh: THREE.Mesh;
      if (mod.nodeType === 'financial_engine') {
        // Concentric Vault Cylinder
        const geo = new THREE.CylinderGeometry(0.8, 0.85, 0.35, 32);
        const mat = new THREE.MeshStandardMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: 0.6,
          metalness: 0.8,
          roughness: 0.2
        });
        nodeMesh = new THREE.Mesh(geo, mat);
      } else if (mod.nodeType === 'workflow_gate') {
        // Torus Ring Gate
        const geo = new THREE.TorusGeometry(0.55, 0.12, 16, 32);
        const mat = new THREE.MeshStandardMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: 0.7,
          wireframe: true
        });
        nodeMesh = new THREE.Mesh(geo, mat);
      } else if (mod.nodeType === 'document_vault') {
        // Rectangular Crystal Slate
        const geo = new THREE.BoxGeometry(0.9, 1.1, 0.18);
        const mat = new THREE.MeshStandardMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: 0.5,
          transparent: true,
          opacity: 0.85
        });
        nodeMesh = new THREE.Mesh(geo, mat);
      } else if (mod.nodeType === 'security_control') {
        // Octahedron Diamond Shield
        const geo = new THREE.OctahedronGeometry(0.65);
        const mat = new THREE.MeshStandardMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: 0.6,
          wireframe: true
        });
        nodeMesh = new THREE.Mesh(geo, mat);
      } else {
        // Rounded Hexagonal Prism Plate for Standard Domain Modules
        const geo = new THREE.CylinderGeometry(0.62, 0.65, 0.22, 6);
        const mat = new THREE.MeshStandardMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: 0.45,
          metalness: 0.6,
          roughness: 0.3
        });
        nodeMesh = new THREE.Mesh(geo, mat);
      }

      group.add(nodeMesh);

      // Glowing outer rim ring
      const ringGeo = new THREE.RingGeometry(0.72, 0.76, 32);
      const ringMat = new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, transparent: true, opacity: 0.5 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.z = 0.15;
      group.add(ring);

      // Raycast Hit Area
      const hitGeo = new THREE.SphereGeometry(0.9, 12, 12);
      const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
      const hitArea = new THREE.Mesh(hitGeo, hitMat);
      hitArea.name = 'hitArea';
      hitArea.userData = { nodeId: mod.id };
      group.add(hitArea);

      // 3D Canvas Label Sprite for Sharp High-Contrast Typography
      const labelSprite = createLabelSprite(`${mod.blueprintNo} · ${mod.code}`, mod.name, mod.color);
      labelSprite.position.set(0, -0.85, 0.2);
      group.add(labelSprite);

      scene.add(group);
      nodeMeshesRef.current.set(mod.id, group);
    });
  };

  const createLabelSprite = (code: string, name: string, hexColor: string): THREE.Sprite => {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;

    // Background card
    ctx.fillStyle = 'rgba(3, 7, 18, 0.85)';
    ctx.strokeStyle = hexColor;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(8, 8, 368, 112, 12);
    ctx.fill();
    ctx.stroke();

    // Code Tag
    ctx.fillStyle = hexColor;
    ctx.font = 'bold 22px monospace';
    ctx.fillText(code, 24, 46);

    // Name
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(name.length > 22 ? name.substring(0, 20) + '...' : name, 24, 88);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(1.8, 0.6, 1);
    return sprite;
  };

  const createRelationshipEdges = (scene: THREE.Scene) => {
    RELATIONSHIP_EDGES.forEach((edge) => {
      const srcMod = BLUEPRINT_MODULES.find((m) => m.id === edge.source);
      const tgtMod = BLUEPRINT_MODULES.find((m) => m.id === edge.target);
      if (!srcMod || !tgtMod) return;

      const p1 = new THREE.Vector3(...srcMod.position3D);
      const p2 = new THREE.Vector3(...tgtMod.position3D);

      // Arching Midpoint for 3D depth
      const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
      mid.z += 1.2;

      const curve = new THREE.QuadraticBezierCurve3(p1, mid, p2);
      const points = curve.getPoints(40);
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);

      // Distinct Line Colors by Type
      let edgeColor = 0x00f0ff;
      if (edge.type === 'financial') edgeColor = 0xf59e0b;
      else if (edge.type === 'approval') edgeColor = 0x10b981;
      else if (edge.type === 'document') edgeColor = 0xb45309;
      else if (edge.type === 'ai_tool') edgeColor = 0x8b5cf6;
      else if (edge.type === 'telegram') edgeColor = 0x0284c7;

      const lineMat = new THREE.LineBasicMaterial({
        color: edgeColor,
        transparent: true,
        opacity: edge.type === 'financial' ? 0.6 : 0.35
      });
      const line = new THREE.Line(lineGeo, lineMat);
      scene.add(line);

      // Traveling Energy Particle Stream
      const particleCount = edge.type === 'financial' ? 8 : 5;
      const particleGeo = new THREE.BufferGeometry();
      const posArray = new Float32Array(particleCount * 3);
      particleGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));

      const particleMat = new THREE.PointsMaterial({
        color: edgeColor,
        size: edge.type === 'financial' ? 0.16 : 0.12,
        transparent: true,
        opacity: 0.9
      });
      const particles = new THREE.Points(particleGeo, particleMat);
      scene.add(particles);

      edgeCurvesRef.current.set(edge.id, { curve, particles, type: edge.type });
    });
  };

  const createSpaceDust = (scene: THREE.Scene) => {
    const particleCount = 240;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount * 3; i += 3) {
      positions[i] = (Math.random() - 0.5) * 30;
      positions[i + 1] = (Math.random() - 0.5) * 20;
      positions[i + 2] = (Math.random() - 0.5) * 15;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0x00f0ff,
      size: 0.05,
      transparent: true,
      opacity: 0.35
    });
    const dust = new THREE.Points(geometry, material);
    scene.add(dust);
  };

  // -------------------------------------------------------------
  // MOUSE & GESTURE EVENT HANDLERS
  // -------------------------------------------------------------

  const handlePointerDown = (e: React.PointerEvent) => {
    isDragging.current = true;
    prevMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    mouseVec.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseVec.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    if (isDragging.current) {
      const deltaX = e.clientX - prevMousePos.current.x;
      const deltaY = e.clientY - prevMousePos.current.y;
      prevMousePos.current = { x: e.clientX, y: e.clientY };

      orbitAngle.current.theta += deltaX * 0.005;
      orbitAngle.current.phi += deltaY * 0.005;

      // Update camera position relative to target
      const radius = targetCamPos.current.distanceTo(targetCamLookAt.current);
      targetCamPos.current.x = targetCamLookAt.current.x + Math.sin(orbitAngle.current.theta) * radius;
      targetCamPos.current.y = targetCamLookAt.current.y + Math.sin(orbitAngle.current.phi) * (radius * 0.5);
      targetCamPos.current.z = targetCamLookAt.current.z + Math.cos(orbitAngle.current.theta) * radius;
    }
  };

  const handlePointerUp = () => {
    isDragging.current = false;
  };

  const handleClick = () => {
    if (hoveredNodeIdRef.current) {
      onNodeSelect(hoveredNodeIdRef.current);
    } else {
      if (selectedNodeId) onNodeSelect(null);
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomDelta = e.deltaY * 0.01;
    const dir = new THREE.Vector3().subVectors(targetCamPos.current, targetCamLookAt.current).normalize();
    const newDist = targetCamPos.current.distanceTo(targetCamLookAt.current) + zoomDelta;
    if (newDist > 4 && newDist < 30) {
      targetCamPos.current.copy(targetCamLookAt.current).addScaledVector(dir, newDist);
    }
  };

  // Gesture-triggered selection & rotation
  useEffect(() => {
    if (!gestureState.isTracking) return;

    // Pinch -> Select currently hovered node
    if (gestureState.isPinching && hoveredNodeIdRef.current) {
      onNodeSelect(hoveredNodeIdRef.current);
    }

    // Both Palms Open -> Reset
    if (gestureState.activeGesture === 'both_palms_open') {
      onNodeSelect(null);
      targetCamPos.current.set(...currentScene.cameraPosition);
      targetCamLookAt.current.set(...currentScene.cameraTarget);
    }

    // Closed Fist -> Back / Deselect
    if (gestureState.activeGesture === 'closed_fist') {
      onNodeSelect(null);
    }
  }, [gestureState, currentScene, onNodeSelect]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing overflow-hidden"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={handleClick}
      onWheel={handleWheel}
      style={{ touchAction: 'none' }}
    />
  );
};
