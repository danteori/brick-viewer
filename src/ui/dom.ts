// The page markup (the legacy viewer's body) and typed references to its elements.

const CHEV = '<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

const MARKUP = `
<canvas id="c"></canvas>
<svg id="dims"></svg>
<svg id="ov"></svg>
<div id="hud"></div>
<div id="side">
  <div id="tool" role="group" aria-label="Tool">
    <button type="button" data-tool="resize" aria-pressed="true" title="Resize (1): drag to resize the focused brick">Resize</button>
    <button type="button" data-tool="move" aria-pressed="false" title="Move (2 or M): drag like Resize, but the focused brick or the selection moves along one axis">Move</button>
    <button type="button" data-tool="paint" aria-pressed="false" title="Paint (3): click or drag over bricks to paint them; Alt+click fills the connected bricks of the same colour; Ctrl+click takes a brick's paint">Paint</button>
  </div>
  <div id="menu" aria-label="Brick size"><div class="mtitle">Brick size</div></div>
  <div id="mode" role="group" aria-label="Brick type">
    <button type="button" data-mode="brick" aria-pressed="true">Brick</button>
    <button type="button" data-mode="plain" aria-pressed="false" title="Plain Tile: flat top with the edge bevel, stud underside">Tile</button>
    <button type="button" data-mode="tile" aria-pressed="false" title="Smooth Tile: flat top, no top bevel, stud underside">Smooth Tile</button>
    <button type="button" data-mode="micro" aria-pressed="false">Microbrick</button>
  </div>
  <div id="file">
    <div id="status">drop or paste (Ctrl+V) a .brz</div>
  </div>
</div>
<div id="name"></div>
<div id="xraybox" role="group" aria-label="X-ray" hidden>
  <label title="Width of the X-ray tube around the focused brick: bricks reaching into it in front of the brick are hidden">Hole <input id="xraysize" type="range" min="0" max="100" step="1" aria-label="X-ray hole size"></label>
  <label title="Dead zone: how far above the focused brick's top nothing is cut, so furniture in the room stays (bricks)">Keep <input id="xraykeep" type="range" min="0" max="20" step="1" aria-label="X-ray dead zone above the focus, bricks"></label>
</div>
<section id="escmenu" class="win" role="dialog" aria-labelledby="escmenutitle" hidden>
  <div class="winhead"><h2 class="wintitle" id="escmenutitle">Menu</h2><button type="button" class="winclose" aria-label="Close">×</button></div>
  <div class="winbody">
    <div class="mbtns" id="mfile">
      <button type="button" id="open">Open save (.brz)</button>
      <div id="saverow"><button type="button" id="savebrz" title="Download the scene as a .brz (uncompressed), written into the save you opened">Save .brz</button></div>
    </div>
    <input type="file" id="pick" accept=".brz,.bp" hidden>
    <div class="mbtns" id="mview"></div>
    <div class="mrows">
      <label id="lightbox">Lighting <select id="light" aria-label="Lighting preset"></select></label>
      <label id="undobox" title="How many edits Ctrl+Z can step back through">Undo steps <input id="undolim" type="number" min="1" max="500" step="1"></label>
      <div id="soundbox" role="group" aria-label="Sound">Sound
        <button type="button" id="mute" aria-pressed="false" title="Mute the editor sounds">On</button>
        <input id="vol" type="range" min="0" max="100" step="1" aria-label="Sound volume" title="Sound volume">
      </div>
      <div id="pastemode" role="group" aria-label="What Ctrl+V does" title="What Ctrl+V does. Dropping a file or the Open button always opens a save.">Ctrl+V
        <button type="button" data-paste="upload" aria-pressed="true" title="Ctrl+V opens a .brz copied in the file manager">Upload</button>
        <button type="button" data-paste="brick" aria-pressed="false" title="Ctrl+V places the brick copied with Ctrl+C">Paste brick</button>
      </div>
      <div id="viewbox" role="group" aria-label="View">View
        <button type="button" id="xray" aria-pressed="false" title="X-ray: hide the bricks between the focused brick and the camera (X)">X-ray (X)</button>
        <button type="button" id="figure" aria-pressed="false" title="Player figure: a player-sized mannequin (4 bricks tall) beside the focused brick, for scale. Not a brick: never saved, picked or collided with (P)">Figure (P)</button>
      </div>
    </div>
  </div>
</section>
<section id="catwin" class="win" role="dialog" aria-labelledby="catwintitle" hidden>
  <div class="winhead"><h2 class="wintitle" id="catwintitle">Bricks</h2><button type="button" class="winclose" aria-label="Close">×</button></div>
  <div class="winbody"><div id="bgrid"></div></div>
</section>
<section id="props" aria-label="Brick properties">
  <button type="button" id="ptoggle" aria-expanded="true" aria-controls="pbody">Brick Properties
    ${CHEV}</button>
  <div id="pbody">
    <div class="prow"><span class="k">Name</span><span class="v" id="pname"></span></div>
    <div class="prow"><span class="k">Type</span><span class="v" id="ptype"></span></div>
    <div class="prow"><span class="k">Size</span><span class="v" id="psize"></span></div>
    <div class="prow"><span class="k">Orientation</span><span class="v" id="porient"></span></div>
    <div class="prow"><span class="k">Material</span><span class="v" id="pmat"></span></div>
    <button type="button" id="pcolor" class="prow" aria-expanded="false" aria-controls="ced"><span class="k">Color</span>
      <span class="v"><span id="cswatch"></span><span id="chexout"></span>
        ${CHEV}</span></button>
    <div id="ced" hidden>
      <div class="cw">
        <canvas id="cwheel" tabindex="0" role="slider" aria-label="Hue and saturation" aria-roledescription="colour wheel"
                aria-valuemin="0" aria-valuemax="360"></canvas>
        <div id="cmark"></div>
      </div>
      <label class="crow"><span>Brightness</span><input type="range" id="cval" min="0" max="1000" step="1" aria-label="Brightness"></label>
      <label class="crow"><span>Hex</span><input id="chex" type="text" maxlength="7" autocomplete="off" spellcheck="false" aria-label="Hex colour, #rgb or #rrggbb"></label>
    </div>
  </div>
  <button type="button" id="comptoggle" aria-expanded="false" aria-controls="compbody" title="The focused brick's components: edit their settings, add or remove one">Components
    <span id="compcount"></span>${CHEV}</button>
  <div id="compbody" hidden></div>
  <button type="button" id="seltoggle" aria-expanded="true" aria-controls="selbody" title="Select several bricks (Shift+click, Shift+drag, Ctrl+A) and move, copy, cut or delete them together">Selection
    <span id="selcount"></span>${CHEV}</button>
  <div id="selbody">
    <div class="selrow selmode" role="group" aria-label="Selector: what Shift+click does">
      <span>Shift+click</span>
      <button type="button" data-selector="brick" aria-pressed="true" title="Shift+click adds one brick at a time">Brick</button>
      <button type="button" data-selector="box" aria-pressed="false" title="Shift+click grows a box from the focused brick; everything fully inside it is selected">Box</button>
    </div>
    <div class="selrow sel3">
      <button type="button" data-sel="all" title="Select every brick (Ctrl+A)">All</button>
      <button type="button" data-sel="colour" title="Select every brick with the focused brick's colour">Colour</button>
      <button type="button" data-sel="type" title="Select every brick of the focused brick's type (its asset, any size)">Type</button>
      <button type="button" data-sel="connected" title="Add every brick touching the selection face to face, and what touches those">Connected</button>
      <button type="button" data-sel="clear" title="Clear the selection (Esc)">Clear</button>
    </div>
    <div class="selrow">
      <button type="button" data-sel="move" title="Pick the selection up and put it down somewhere else (M)">Move</button>
      <button type="button" data-sel="copy" title="Copy the selection (Ctrl+C)">Copy</button>
      <button type="button" data-sel="cut" title="Cut the selection (Ctrl+X)">Cut</button>
      <button type="button" data-sel="delete" title="Delete the selection (Delete)">Delete</button>
    </div>
    <div class="selrow sel2">
      <button type="button" data-mirror="0" title="Mirror the selection, or the brick in hand, across X (Alt+X)">Mirror X</button>
      <button type="button" data-mirror="1" title="Mirror the selection, or the brick in hand, across Y (Alt+Y)">Mirror Y</button>
    </div>
  </div>
  <button type="button" id="gridtoggle" aria-expanded="false" aria-controls="gridbody" hidden title="Moving grids (vehicles, doors): select one, make one from the selection, move bricks between grids, type a grid's place">Grid
    <span id="gridname"></span>${CHEV}</button>
  <div id="gridbody" hidden>
    <div class="gridrow g2">
      <button type="button" data-grid="select" title="Select every brick of the focused brick's grid">Select grid</button>
      <button type="button" data-grid="new" title="Make the selection (or the focused brick) a new moving grid, where it is">New grid</button>
    </div>
    <div class="gridrow gto">
      <select id="gridto" aria-label="Grid to move the selection into"></select>
      <button type="button" data-grid="to" title="Move the selection (or the focused brick) into the chosen grid, where it is">Move to grid</button>
    </div>
    <div id="gridxf">
      <span class="gk">Location</span>
      <input type="number" step="1" data-xf="0" aria-label="Grid location X (units)" title="X, in units (a stud is 10)">
      <input type="number" step="1" data-xf="1" aria-label="Grid location Y (units)" title="Y, in units">
      <input type="number" step="1" data-xf="2" aria-label="Grid location Z (units)" title="Z, in units (a plate is 4)">
      <span class="gk">Rotation</span>
      <input type="number" step="90" data-xf="3" aria-label="Grid yaw (degrees, about Z)" title="Yaw: degrees about Z">
      <input type="number" step="90" data-xf="4" aria-label="Grid pitch (degrees, about Y)" title="Pitch: degrees about Y">
      <input type="number" step="90" data-xf="5" aria-label="Grid roll (degrees, about X)" title="Roll: degrees about X">
      <button type="button" data-grid="apply" title="Place the grid there (Enter in a box does the same)">Apply</button>
      <span id="gridnote"></span>
    </div>
  </div>
  <button type="button" id="painttoggle" aria-expanded="false" aria-controls="paintbody" title="Colour palette, material and intensity: paint the selection (or the focused brick)">Paint
    ${CHEV}</button>
  <div id="paintbody" hidden></div>
  <button type="button" id="apptoggle" aria-expanded="false" aria-controls="appbody" title="Change the brick type or the material of the selection (or the focused brick), like the game's applicator">Applicator
    ${CHEV}</button>
  <div id="appbody" hidden>
    <div class="approw"><span>Type</span><select id="apptype" aria-label="Brick type to apply"></select>
      <button type="button" id="appapplytype" title="Change the selection (or the focused brick) to this type: resizable types keep their size, fixed ones take their own">Apply</button></div>
    <div class="approw"><span>Material</span><select id="appmat" aria-label="Material to apply"></select>
      <button type="button" id="appapplymat" title="Give the selection (or the focused brick) this material, keeping its colour and intensity">Apply</button></div>
    <button type="button" id="apppick" title="Set both lists to the focused brick's type and material">Take from the focused brick</button>
  </div>
</section>`;

/** Builds the page into document.body (the #app placeholder is replaced). */
export function mountDom(root: HTMLElement | null): void {
  const tpl = document.createElement('template');
  tpl.innerHTML = MARKUP;
  if (root && root !== document.body) root.replaceWith(tpl.content);
  else document.body.append(tpl.content);
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
