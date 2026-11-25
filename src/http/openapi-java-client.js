'use strict';

const {validIdentifier}=require('../java/file-templates');

const controlledHeaders=new Set(['host','content-length','connection','transfer-encoding','expect','upgrade']);
const scalarTypes=new Map([
  ['string','String'],['unspecified','String'],['integer','Long'],['number','BigDecimal'],['boolean','Boolean']
]);
const styles={path:'simple',query:'form',header:'simple',cookie:'form'};
const importedNames=new Set(['IOException','BigDecimal','URI','URLEncoder','HttpClient','HttpRequest','HttpResponse',
  'StandardCharsets','Duration','ArrayList','List','Map','Objects','String','Object','Long','Boolean',
  'InterruptedException','IllegalArgumentException']);
const titleCase=value=>(value.match(/[A-Za-z0-9]+/g)||[]).map(part=>part[0].toUpperCase()+part.slice(1)).join('');
const literal=value=>JSON.stringify(value);

function nameOperation(operation) {
  const chosen=titleCase(operation.id||'');
  return 'call'+(chosen||titleCase(operation.method+' '+operation.path));
}

function javaMethod(operation,name) {
  const {method,path,requestBody}=operation;
  if (!/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)||
      !/^\/(?!\/)[\p{L}\p{N}_.~!$&'()*+,;=:@%/{}-]*$/u.test(path)||/%(?![a-f\d]{2})/i.test(path)) {
    throw Error('Choose an operation with a supported HTTP method and URI path.');
  }
  if (requestBody&&(!requestBody.json||['GET','HEAD'].includes(method))) {
    throw Error('Choose an operation with no request body or an application/json body on a write method.');
  }
  const parameters=[],variables=new Set();
  for (const field of operation.parameters) {
    const location=field.in;
    const suffix=titleCase(field.name);
    const identifier=location+suffix;
    const type=scalarTypes.get(field.type);
    if (!suffix||!type||!styles[location]||field.style!==undefined&&field.style!==styles[location]||field.allowReserved||
        variables.has(identifier)||location==='header'&&
        (controlledHeaders.has(field.name.toLowerCase())||requestBody&&field.name.toLowerCase()==='content-type')) {
      throw Error('Choose supported scalar parameters with default serialization and distinct Java names.');
    }
    variables.add(identifier);
    parameters.push({...field,identifier,type});
  }
  const pathParts=[];
  let end=0;
  for (const placeholder of path.matchAll(/\{([^{}]+)\}/g)) {
    const field=parameters.find(item=>item.in==='path'&&item.name===placeholder[1]);
    if (!field) throw Error('Choose an operation with declared path parameters.');
    if (placeholder.index>end) pathParts.push(literal(path.slice(end,placeholder.index)));
    pathParts.push('encodePath('+field.identifier+')');
    end=placeholder.index+placeholder[0].length;
  }
  if (end<path.length) pathParts.push(literal(path.slice(end)));
  const argumentsText=[...parameters.map(item=>item.type+' '+item.identifier),...(requestBody?['String jsonBody']:[])].join(', ');
  const lines=[
    '    public HttpResponse<byte[]> '+name+'('+argumentsText+') throws IOException, InterruptedException {',
    '        String path = '+pathParts.join(' + ')+';',
    '        List<String> query = new ArrayList<>();'
  ];
  function addConditional(field,statement) {
    lines.push('        '+(field.required?'':'if ('+field.identifier+' != null) ')+statement);
  }
  for (const field of parameters.filter(value=>value.in==='query')) {
    addConditional(field,'query.add('+literal(field.name+'=')+' + encode('+field.identifier+'));');
  }
  lines.push('        HttpRequest.Builder request = request(path, query);');
  for (const field of parameters.filter(value=>value.in==='header')) {
    addConditional(field,'request.setHeader('+literal(field.name)+', Objects.requireNonNull('+field.identifier+').toString());');
  }
  const cookies=parameters.filter(value=>value.in==='cookie');
  if (cookies.length) {
    lines.push('        List<String> cookies = new ArrayList<>();');
    for (const field of cookies) {
      addConditional(field,'cookies.add('+literal(field.name+'=')+' + encode('+field.identifier+'));');
    }
    lines.push('        if (!cookies.isEmpty()) request.setHeader("Cookie", String.join("; ", cookies));');
  }
  lines.push('        HttpRequest.BodyPublisher body = HttpRequest.BodyPublishers.noBody();');
  if (requestBody) {
    if (requestBody.required) lines.push('        Objects.requireNonNull(jsonBody, "jsonBody");');
    lines.push('        if (jsonBody != null) {',
      '            request.setHeader("Content-Type", "application/json");',
      '            body = HttpRequest.BodyPublishers.ofString(jsonBody);',
      '        }');
  }
  lines.push('        return http.send(request.method('+literal(method)+', body).build(), HttpResponse.BodyHandlers.ofByteArray());',
    '    }');
  return lines.join('\n');
}

function javaClientSource(operations,{className='OpenApiClient',packageName=''}={}) {
  if (!validIdentifier(className)||importedNames.has(className)||typeof packageName!=='string'||
      packageName&&!packageName.split('.').every(validIdentifier)) {
    throw Error('Use a valid Java class and package name.');
  }
  if (!Array.isArray(operations)||!operations.length||operations.length>40) {
    throw Error('Select between one and 40 OpenAPI operations.');
  }
  const names=new Set();
  const methods=operations.map(operation=>{
    const name=nameOperation(operation);
    if (names.has(name)||name.length>160) throw Error('Choose operations with distinct, bounded Java names.');
    names.add(name);
    return javaMethod(operation,name);
  });
  const source=[
    ...(packageName?['package '+packageName+';','']:[]),
    'import java.io.IOException;',
    'import java.math.BigDecimal;',
    'import java.net.URI;',
    'import java.net.URLEncoder;',
    'import java.net.http.HttpClient;',
    'import java.net.http.HttpRequest;',
    'import java.net.http.HttpResponse;',
    'import java.nio.charset.StandardCharsets;',
    'import java.time.Duration;',
    'import java.util.ArrayList;',
    'import java.util.List;',
    'import java.util.Map;',
    'import java.util.Objects;',
    '',
    'public final class '+className+' {',
    '    private final String base;',
    '    private final Map<String, String> headers;',
    '    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();',
    '',
    '    public '+className+'(URI baseUri, Map<String, String> defaultHeaders) {',
    '        Objects.requireNonNull(baseUri);',
    '        if (!("http".equalsIgnoreCase(baseUri.getScheme()) || "https".equalsIgnoreCase(baseUri.getScheme()))',
    '                || baseUri.getHost() == null || baseUri.getUserInfo() != null',
    '                || baseUri.getQuery() != null || baseUri.getFragment() != null) {',
    '            throw new IllegalArgumentException("Use an HTTP(S) base URI with a host and optional path.");',
    '        }',
    '        base = baseUri.toASCIIString().replaceFirst("/+$", "");',
    '        headers = Map.copyOf(defaultHeaders);',
    '    }',
    '',
    '    private static String encode(Object value) {',
    '        return URLEncoder.encode(Objects.requireNonNull(value).toString(), StandardCharsets.UTF_8).replace("+", "%20");',
    '    }',
    '',
    '    private static String encodePath(Object value) {',
    '        String part = encode(value);',
    '        return part.equals(".") || part.equals("..") ? part.replace(".", "%2E") : part;',
    '    }',
    '',
    '    private HttpRequest.Builder request(String path, List<String> query) {',
    '        String suffix = query.isEmpty() ? "" : "?" + String.join("&", query);',
    '        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(base + path + suffix)).timeout(Duration.ofSeconds(30));',
    '        headers.forEach(builder::header);',
    '        return builder;',
    '    }',
    '',
    methods.join('\n\n'),
    '}',''
  ].join('\n');
  if (Buffer.byteLength(source)>256*1024) throw Error('Choose fewer operations for the Java client.');
  return source;
}

module.exports={javaClientSource};
