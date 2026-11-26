'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {SaxesParser}=require('saxes');
const {inside}=require('./workbench-model');

const FX=/^https?:\/\/javafx\.com\/fxml(?:\/\d+)?$/u;
const JAVAFX=/^https?:\/\/javafx\.com\/javafx(?:\/[\d.]+)?$/u;
const id=/^[A-Za-z_$][\w$]{0,95}$/u;
const className=/^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/u;
const localPath=/^[A-Za-z0-9_./-]{1,240}$/u;
const types=new Map();
for (const [location,names] of Object.entries({
  'javafx.scene':'Group',
  'javafx.scene.layout':'AnchorPane BorderPane FlowPane GridPane HBox Pane Region StackPane TilePane VBox',
  'javafx.scene.control':'Button CheckBox ChoiceBox ComboBox Hyperlink Label PasswordField ProgressBar ProgressIndicator RadioButton ScrollPane Separator Slider TextArea TextField ToggleButton',
  'javafx.scene.shape':'Circle Ellipse Line Rectangle SVGPath',
  'javafx.scene.text':'Text'
})) for (const name of names.split(' ')) types.set(name,location+'.'+name);

const properties=new Set(('id styleClass style visible managed disable opacity mouseTransparent focusTraversable '+
  'layoutX layoutY translateX translateY scaleX scaleY rotate viewOrder minWidth minHeight maxWidth maxHeight prefWidth prefHeight '+
  'alignment spacing hgap vgap fillWidth fillHeight orientation prefRows prefColumns '+
  'text promptText wrapText textAlignment mnemonicParsing underline contentDisplay graphicTextGap ellipsisString '+
  'editable selected indeterminate allowIndeterminate progress value min max blockIncrement snapToTicks showTickMarks showTickLabels '+
  'fitToWidth fitToHeight pannable hbarPolicy vbarPolicy prefViewportWidth prefViewportHeight '+
  'width height x y startX startY endX endY centerX centerY radius radiusX radiusY arcWidth arcHeight fill stroke strokeWidth content').split(' '));
const attached=new Set(('AnchorPane.topAnchor AnchorPane.bottomAnchor AnchorPane.leftAnchor AnchorPane.rightAnchor '+
  'GridPane.columnIndex GridPane.rowIndex GridPane.columnSpan GridPane.rowSpan GridPane.hgrow GridPane.vgrow '+
  'HBox.hgrow VBox.vgrow StackPane.alignment BorderPane.alignment').split(' '));
const regions=new Set('children center top right bottom left content graphic'.split(' '));
const cssProperties=new Set(('-fx-background-color -fx-background-insets -fx-background-radius -fx-border-color '+
  '-fx-border-insets -fx-border-radius -fx-border-style -fx-border-width -fx-padding -fx-spacing -fx-hgap -fx-vgap '+
  '-fx-alignment -fx-text-fill -fx-font-size -fx-font-family -fx-font-weight -fx-font-style -fx-text-alignment '+
  '-fx-wrap-text -fx-opacity -fx-fill -fx-stroke -fx-stroke-width -fx-stroke-type -fx-arc-width -fx-arc-height '+
  '-fx-pref-width -fx-pref-height -fx-min-width -fx-min-height -fx-max-width -fx-max-height -fx-effect').split(' '));
const EMPTY=new Set(['',undefined]);
const decode=new TextDecoder('utf-8',{fatal:true});
const hash=source=>createHash('sha256').update(source).digest('hex');
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  .replaceAll('"','&quot;').replaceAll('\n','&#10;').replaceAll('\r','&#13;');

function css(source) {
  const text=source.replace(/\/\*[\s\S]*?\*\//gu,'');
  if (/[\\@\0]/u.test(text)||/\/\*/u.test(text)||/\burl\s*\(/iu.test(text)||/(?:-fx-skin|\bsrc|https?|file|jar|data|ftp)\s*:/iu.test(text)) {
    throw Error('FXML preview supports static CSS without imports, URLs, custom skins or CSS escapes.');
  }
  for (const match of text.matchAll(/(?:^|[;{])\s*([-\w]+)\s*:/gu)) {
    if (!cssProperties.has(match[1])) throw Error('Unsupported static CSS property '+match[1]+'.');
  }
}

function resourceBase(file,root) {
  const parts=path.relative(root,file).split(path.sep);
  for (let i=parts.length-4;i>=0;i--) {
    if (parts[i]==='src'&&parts[i+1]==='main'&&parts[i+2]==='resources') return path.join(root,...parts.slice(0,i+3));
  }
  return path.dirname(file);
}

function physical(file,boundary,max) {
  const actual=fs.realpathSync(file),stat=fs.lstatSync(file);
  if (!inside(boundary,actual)||path.relative(file,actual)||!stat.isFile()||stat.isSymbolicLink()||stat.size>max) {
    throw Error('FXML preview resources must be bounded physical files inside the selected resource directory.');
  }
  const bytes=fs.readFileSync(actual);
  if (bytes.length>max) throw Error('A preview resource grew during inspection.');
  return bytes;
}

function targetOf(reference,from,root,suffix) {
  if (!localPath.test(reference)||reference.startsWith('//')||path.posix.extname(reference)!==suffix) {
    throw Error('Use a local '+suffix+' resource in the FXML preview.');
  }
  const file=reference.startsWith('/')?path.resolve(root,reference.slice(1)):path.resolve(path.dirname(from),reference);
  if (!inside(root,file)) throw Error('The FXML preview resource escapes its physical resource directory.');
  return file;
}

function stageName(from,to) {
  return path.relative(path.dirname(from),to).split(path.sep).join('/');
}

function captureFxmlPreview(file,workspace,{dirty=()=>false}={}) {
  if (!path.isAbsolute(file)||!path.isAbsolute(workspace)||!inside(workspace,file)||path.extname(file)!=='.fxml') {
    throw Error('Select a saved local FXML document in the trusted workspace.');
  }
  const root=resourceBase(file,workspace);
  const files=new Map(), visiting=new Set();
  let bytes=0,nodes=0,controllers=0,handlers=0;
  function capture(source,suffix) {
    if (visiting.has(source)) throw Error('The FXML preview has a cyclic include.');
    if (files.has(source)) return;
    if (files.size+visiting.size>=24||visiting.size>=12) throw Error('Preview up to 24 physical files and 12 nested includes.');
    if (dirty(source)) throw Error('Save the selected FXML and all of its preview resources before rendering.');
    const raw=physical(source,root,suffix==='.css'?128*1024:512*1024);
    if ((bytes+=raw.length)>2*1024*1024) throw Error('The FXML preview resource graph exceeds 2 MiB.');
    const text=decode.decode(raw);
    visiting.add(source);
    try {
      const staged=suffix==='.css'?(css(text),text):projectFxml(text,source);
      files.set(source,{hash:hash(raw),staged});
    } finally {visiting.delete(source);}
  }

  function projectFxml(text,source) {
    const parser=new SaxesParser({xmlns:true}),stack=[],imports=new Set(),parts=[];
    parser.on('doctype',()=>{throw Error('FXML document types are outside the static preview.');});
    parser.on('processinginstruction',entry=>{
      const name=entry.body.trim();
      if (entry.target!=='import'||![...types.values()].some(type=>name===type||name===type.slice(0,type.lastIndexOf('.')+1)+'*')) {
        throw Error('Use only supported JavaFX built-in imports in the FXML preview.');
      }
    });
    parser.on('opentag',tag=>{
      if (++nodes>1800||stack.length>=36) throw Error('The FXML preview has too many nodes or nested properties.');
      const name=tag.local,include=FX.test(tag.uri)&&name==='include';
      const prefix=stack.length===0;
      let outputName;
      if (include) outputName='fx:include';
      else if (EMPTY.has(tag.uri)||JAVAFX.test(tag.uri)) {
        const type=types.get(name)||([...types.values()].includes(name)?name:undefined);
        if (type) {
          imports.add(type);
          outputName=type.split('.').at(-1);
        } else if (!prefix&&regions.has(name)) outputName=name;
      }
      if (!outputName||prefix&&include) throw Error('Unsupported FXML preview element '+tag.name+'.');
      if (stack.at(-1)==='fx:include') throw Error('Static FXML includes cannot contain nested properties.');
      const attributes=prefix?['xmlns:fx="http://javafx.com/fxml/1"']:[];
      let includeSource=false;
      for (const attribute of Object.values(tag.attributes)) {
        const {local,uri,value}=attribute;
        if (uri==='http://www.w3.org/2000/xmlns/') continue;
        if (FX.test(uri)&&local==='controller'&&prefix&&className.test(value)) {controllers++;continue;}
        if (FX.test(uri)&&local==='id'&&id.test(value)) {
          attributes.push('fx:id="'+escape(value)+'"');
          continue;
        }
        if (uri||value.length>4096||/[\0-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) {
          throw Error('Unsupported FXML preview attribute '+attribute.name+'.');
        }
        if (include) {
          if (local!=='source') throw Error('Static FXML includes require only a local source and optional fx:id.');
          const child=targetOf(value,source,root,'.fxml');
          capture(child,'.fxml');
          attributes.push('source="'+escape(stageName(source,child))+'"');
          includeSource=true;
          continue;
        }
        if (/^on[A-Z]/u.test(local)) {
          if (!value.startsWith('#')||!id.test(value.slice(1))) throw Error('Executable FXML event expressions are outside the static preview.');
          handlers++;
          continue;
        }
        if (local==='stylesheets'&&value.startsWith('@')) {
          const style=targetOf(value.slice(1),source,root,'.css');
          capture(style,'.css');
          attributes.push('stylesheets="@'+escape(stageName(source,style))+'"');
          continue;
        }
        if (!(properties.has(local)||attached.has(local))||/^\s*[$%@\\]/u.test(value)) {
          throw Error('FXML preview requires static built-in properties. Unsupported attribute '+local+'.');
        }
        if (local==='style') css(value);
        attributes.push(local+'="'+escape(value)+'"');
      }
      if (include&&!includeSource) throw Error('A static FXML include requires a local source file.');
      parts.push('<'+outputName+(attributes.length?' '+attributes.join(' '):'')+'>');
      stack.push(outputName);
    });
    parser.on('closetag',()=>parts.push('</'+stack.pop()+'>'));
    parser.on('text',value=>{if (value.trim()) throw Error('Use static text attributes in the FXML preview.');});
    parser.on('cdata',()=>{throw Error('FXML CDATA is outside the static preview.');});
    parser.write(text).close();
    return '<?xml version="1.0" encoding="UTF-8"?>\n'+[...imports].sort().map(type=>'<?import '+type+'?>').join('\n')+
      '\n'+parts.join('\n')+'\n';
  }

  capture(file,'.fxml');
  const summary={resourceCount:files.size,controllersOmitted:controllers,handlersOmitted:handlers};
  const fingerprint=hash(JSON.stringify([...files].map(([file,value])=>[file,value.hash]).sort()));
  return {root,file,files,summary,fingerprint};
}

module.exports={captureFxmlPreview};
