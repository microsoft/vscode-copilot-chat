const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(75, 9/16, 0.1, 1000);

const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000);
document.body.appendChild(renderer.domElement);

camera.position.z = 10;

// 🔊 AUDIO
const listener = new THREE.AudioListener();
camera.add(listener);

const sound = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();

audioLoader.load('music.mp3', function(buffer){
    sound.setBuffer(buffer);
    sound.setLoop(false);
    sound.setVolume(0.7);
});

// iniciar música al primer click (evita bloqueo navegador)
window.addEventListener("click", ()=>{
    if(!sound.isPlaying){
        sound.play();
    }
});

// resize
window.addEventListener("resize", () => {
    camera.aspect = 9/16;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ⭐ FONDO ESTRELLAS
const starsGeometry = new THREE.BufferGeometry();
let starsPos = [];

for(let i=0;i<10000;i++){
    starsPos.push(
        (Math.random()-0.5)*100,
        (Math.random()-0.5)*100,
        (Math.random()-0.5)*100
    );
}

starsGeometry.setAttribute("position", new THREE.Float32BufferAttribute(starsPos,3));

const stars = new THREE.Points(
    starsGeometry,
    new THREE.PointsMaterial({
        color:0xffffff,
        size:0.2,
        transparent:true,
        opacity:0.8
    })
);

scene.add(stars);

// 🌌 GALAXIA
const group = new THREE.Group();
scene.add(group);

const geometry = new THREE.BufferGeometry();
let pos = [];

let branches = 3;
let spin = 1.2;

for(let i=0;i<8000;i++){
    let r = Math.random()*5;

    let branchAngle = (i % branches) / branches * Math.PI * 2;
    let angle = branchAngle + r * spin;

    pos.push(
        Math.cos(angle)*r,
        (Math.random()-0.5)*0.3,
        Math.sin(angle)*r
    );
}

geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos,3));

const galaxy = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
        size:0.12,
        color:0xff66cc,
        blending:THREE.AdditiveBlending,
        transparent:true,
        opacity:0.8
    })
);

group.add(galaxy);
group.rotation.x = 0.6;
group.rotation.z = 0.3;

// TEXTURAS
const loader = new THREE.TextureLoader();
const foto = loader.load("imagen.jpeg");
const heartTex = loader.load("imagen.jpeg");
const osoTex = loader.load("foto.jpg");

// 🖼️ FOTOS
let fotos = [];
for(let i=0;i<3;i++){
    let img = new THREE.Mesh(
        new THREE.PlaneGeometry(1,1),
        new THREE.MeshBasicMaterial({ map: foto, transparent:true })
    );
    group.add(img);
    fotos.push({mesh:img, offset:i*2});
}

// 🧸 OSOS
let osos = [];
for(let i=0;i<3;i++){
    let o = new THREE.Mesh(
        new THREE.PlaneGeometry(0.8,0.8),
        new THREE.MeshBasicMaterial({ map: osoTex, transparent:true })
    );
    group.add(o);
    osos.push({mesh:o, offset:i*2});
}

// 💬 TEXTOS
function crearTexto(txt){
    let canvas = document.createElement("canvas");
    let ctx = canvas.getContext("2d");

    canvas.width=512;
    canvas.height=256;

    ctx.fillStyle="#0c10d8";
    ctx.font="bold 57px Algerian";
    ctx.fillText(txt,40,130);

    let texture = new THREE.CanvasTexture(canvas);

    return new THREE.Mesh(
        new THREE.PlaneGeometry(2,1),
        new THREE.MeshBasicMaterial({ map:texture, transparent:true })
    );
}

let textos = [
    crearTexto("Te amo"),
    crearTexto("Te quiero mucho"),
    crearTexto("Eres la más hermosa"),
    crearTexto("te amo princesa")
];

textos.forEach(t => group.add(t));

// ❤️ CORAZÓN CENTRAL
function crearCorazon(){
    const shape = new THREE.Shape();

    shape.moveTo(0,0);
    shape.bezierCurveTo(0,2,-3,2,-3,0);
    shape.bezierCurveTo(-3,-2,0,-3,0,-5);
    shape.bezierCurveTo(0,-3,3,-2,3,0);
    shape.bezierCurveTo(3,2,0,2,0,0);

    const geo = new THREE.ShapeGeometry(shape);
    const mat = new THREE.MeshBasicMaterial({ color:0xff4da6 });

    let heart = new THREE.Mesh(geo,mat);
    heart.scale.set(0,0,0);
    return heart;
}

let mainHeart = crearCorazon();
scene.add(mainHeart);

// 💥 PARTÍCULAS (ositos)
let particles = [];
for(let i=0;i<200;i++){
    let p = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: osoTex, transparent:true })
    );
    p.scale.set(0.2,0.2,0.2);
    p.visible = false;
    scene.add(p);

    particles.push({mesh:p});
}

// 🖼️ FOTO FINAL
let finalImage = new THREE.Mesh(
    new THREE.PlaneGeometry(2,2),
    new THREE.MeshBasicMaterial({
        map: foto,
        transparent:true,
        opacity:0.95
    })
);

finalImage.scale.set(0,0,0);
scene.add(finalImage);

// 💖 CORAZÓN FINAL
let heartGroup = new THREE.Group();
scene.add(heartGroup);

let orbitHearts = [];

for(let i=0;i<80;i++){
    let s = new THREE.Sprite(
        new THREE.SpriteMaterial({
            map: heartTex,
            color:0xff66cc,
            transparent:true
        })
    );

    s.scale.set(0.18,0.18,0.18);
    heartGroup.add(s);
    orbitHearts.push(s);
}

// tiempo
let start = Date.now();

// 🎬 ANIMACIÓN
function animate(){
    requestAnimationFrame(animate);

    let time = Date.now()*0.002;
    let t = (Date.now()-start)/1000;

    stars.rotation.y += 0.0005;

    if(t < 6){
        group.rotation.y += 0.002;

        fotos.forEach(f=>{
            let a = time * 0.3 + f.offset;
            f.mesh.position.x = Math.cos(a)*3;
            f.mesh.position.z = Math.sin(a)*3;
            f.mesh.lookAt(camera.position);
        });

        osos.forEach(o=>{
            let a = time * 0.3 + o.offset + Math.PI;
            o.mesh.position.x = Math.cos(a)*3;
            o.mesh.position.z = Math.sin(a)*3;
            o.mesh.lookAt(camera.position);
        });

        textos.forEach((txt,i)=>{
            let a = time * 0.25 + i*2;
            txt.position.x = Math.cos(a)*4;
            txt.position.z = Math.sin(a)*4;
            txt.lookAt(camera.position);
        });
    }

    if(t > 5 && t < 7){
        let scale = (t - 5) * 1.5;
        mainHeart.scale.set(scale, scale, scale);
    }

    if(t > 7){
        group.visible = false;
        mainHeart.visible = false;

        particles.forEach((p,i)=>{
            p.mesh.visible = true;

            let tt = (i / particles.length) * Math.PI * 2;

            let x = 16 * Math.pow(Math.sin(tt),3);
            let y = -(13*Math.cos(tt) - 5*Math.cos(2*tt)
                  - 2*Math.cos(3*tt) - Math.cos(4*tt));

            let expand = 1 + (t-7)*0.4;

            p.mesh.position.set(x*0.12*expand, y*0.12*expand, 0);
        });
    }

    if(t > 8){
        finalImage.scale.set(1.2,1.2,1.2);

        heartGroup.rotation.set(0,0,Math.PI);

        orbitHearts.forEach((h,i)=>{
            let tt = (i / orbitHearts.length) * Math.PI * 2;

            let x = 16 * Math.pow(Math.sin(tt),3);
            let y = -(13*Math.cos(tt) - 5*Math.cos(2*tt)
                  - 2*Math.cos(3*tt) - Math.cos(4*tt));

            h.position.set(x*0.09, y*0.09, 0);
        });

        let glow = 1 + Math.sin(time*4)*0.1;
        heartGroup.scale.set(glow, glow, glow);

        camera.position.z -= 0.005;
    }

    renderer.render(scene, camera);
}

animate();