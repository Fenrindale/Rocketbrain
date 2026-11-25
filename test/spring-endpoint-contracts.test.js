'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseEndpointContracts } = require('../src/spring/endpoint-contracts');
const { sourceEndpoints } = require('../src/java/spring');

const flux = 'org.springframework.web.reactive.function.server';
const web = 'org.springframework.web.bind.annotation';
const routerFile = (routes,extra = '',owner = 'RouterFunction<ServerResponse>') => `
  package sample;
  import org.springframework.context.annotation.Bean;
  import ${flux}.*;
  ${extra}
  class Routes { @Bean ${owner} fixed() { ${routes} } }
`;

function summarize(items) {
  return items.map(item => [item.kind,item.state,item.methods.join('|'),item.path]);
}

function from(source, item) {
  const start = item.range.start, end = item.range.end;
  assert.equal(start.line,end.line);
  return source.split('\n')[start.line].slice(start.character,end.character);
}

test('WebFlux methods, nested paths, qualifiers and alternate static router factories have exact source spans', () => {
  const source = routerFile(`
    return route()
      .path("/api", api -> api
        .nest(RequestPredicates.accept(TEXT_PLAIN), json -> json
          .GET("/items/{id}", handler::get))
        .nest(RequestPredicates.path("/commands"), (commands) -> { commands.POST("/run/", handler::run); }))
      .add(RouterFunctions.route(RequestPredicates.GET("/collection").and(RequestPredicates.accept(TEXT_PLAIN)), handler::all))
      .path("/supplier", () -> RouterFunctions.route(RequestPredicates.GET("/item"), handler::read))
      .route(RequestPredicates.method(org.springframework.http.HttpMethod.OPTIONS).and(RequestPredicates.path("/ping")), handler::ping)
      .build();
  `,`import static ${flux}.RouterFunctions.route;`);
  const items = parseEndpointContracts(source,'file:///Routes.java');
  assert.deepEqual(summarize(items), [
    ['webflux','declared','GET','/api/items/{id}'],
    ['webflux','declared','POST','/api/commands/run/'],
    ['webflux','declared','GET','/collection'],
    ['webflux','declared','GET','/supplier/item'],
    ['webflux','declared','OPTIONS','/ping']
  ]);
  assert.deepEqual(items.map(item => from(source,item)),['GET','POST','RouterFunctions.route','RouterFunctions.route','route']);
  assert.deepEqual(items.map(item => item.constrained),[true,false,true,false,false]);
  assert.ok(items.every(item=>item.uri==='file:///Routes.java' && item.method==='fixed'));
});

test('direct static nesting, explicit AND and path-only predicates keep matching method constraints separate', () => {
  const source = routerFile(`
    return RouterFunctions.nest(path("/outer"),
      RouterFunctions.route(GET("/item"), handler::get)
        .andRoute(path("/all"), handler::all)
        .and(RouterFunctions.route(POST("/new"), handler::create)));
  `,`import static ${flux}.RequestPredicates.*;`);
  assert.deepEqual(summarize(parseEndpointContracts(source)),[
    ['webflux','declared','GET','/outer/item'],['webflux','declared','ANY','/outer/all'],['webflux','declared','POST','/outer/new']
  ]);
});

test('computed routes, unconstrained method builders, OR and branch-derived routers stay unresolved', () => {
  const source = routerFile(`
    return RouterFunctions.route()
      .GET(PATH, handler::read)
      .GET(handler::read)
      .nest(RequestPredicates.path(computed()), nested -> nested.GET("/hidden", handler::read))
      .route(RequestPredicates.GET("/one").or(RequestPredicates.GET("/two")), handler::read)
      .GET("/literal" + dynamic, handler::read)
      .GET("/\${configured}", handler::read)
      .POST("/known", handler::read)
      .build();
  `);
  const items = parseEndpointContracts(source);
  assert.equal(items.filter(item=>item.path===null && item.state==='unresolved').length,6);
  assert.deepEqual(items.filter(item=>item.path!==null).map(item=>item.path),['/known']);
  const branch = routerFile('if (flag) return RouterFunctions.route().GET("/wrong", handler::x).build(); return selected();');
  assert.deepEqual(summarize(parseEndpointContracts(branch)),[['webflux','unresolved','',null]]);
});

test('router and Feign type identity excludes comments, duplicate imports, WebMvc.fn and unrelated same-name declarations', () => {
  const wrong = routerFile('return RouterFunctions.route().GET("/wrong", handler::get).build();',
    'import other.RouterFunctions;');
  assert.deepEqual(summarize(parseEndpointContracts(wrong)),[['webflux','unresolved','',null]]);
  const mvc = routerFile('return RouterFunctions.route().GET("/mvcfn", handler::get).build();',
    'import org.springframework.web.servlet.function.RouterFunction;');
  assert.deepEqual(parseEndpointContracts(mvc),[]);
  const unrelated = 'import foreign.FeignClient; import foreign.GetMapping; @FeignClient interface Other { @GetMapping("/ignored") String x(); }';
  assert.deepEqual(parseEndpointContracts(unrelated),[]);
  const fake = routerFile('return handedIn; // RouterFunctions.route().GET("/ignored", handler::x)\n');
  assert.equal(parseEndpointContracts(fake)[0].path,null);
});

test('outbound Feign contracts prove one HTTP method and path with alias, prefix and symbol ranges', () => {
  const source = `
    package example;
    import org.springframework.cloud.openfeign.FeignClient;
    import ${web}.*;
    import static ${web}.RequestMethod.HEAD;
    @FeignClient(name="service", url="https://private.example", path="root/")
    interface Contract extends SharedContract {
      @GetMapping(path = "/opened/{id}", produces = "text/plain") String get();
      @RequestMapping(value="/info", method={ HEAD }) String head();
      @RequestMapping(value={"default",}) String defaultHttpMethod();
      @RequestMapping(method=RequestMethod.POST) String root();
      @GetMapping(path="/prefix" + PATH) String computed();
      @GetMapping({"/multiple", "/paths"}) String invalid();
      @other.DeleteMapping("/ignored") String foreign();
    }
  `;
  const items = parseEndpointContracts(source);
  assert.deepEqual(summarize(items),[
    ['feign','unresolved','',null],
    ['feign','declared','GET','/root/opened/{id}'],
    ['feign','declared','HEAD','/root/info'],
    ['feign','declared','GET','/root/default'],
    ['feign','declared','POST','/root'],
    ['feign','unresolved','',null],
    ['feign','unresolved','',null]
  ]);
  assert.match(from(source,items[1]),/^@GetMapping/);
  assert.equal(items[1].method,'get');
  assert.ok(items[1].constrained);
  assert.ok(!JSON.stringify(items).includes('private.example'));
});

test('dynamic Feign prefixes and custom contracts are explicit and do not claim literal outbound targets', () => {
  const source = `
    import org.springframework.cloud.openfeign.FeignClient;
    import ${web}.GetMapping;
    @FeignClient(name="a", path="/\${prefix}") interface Dynamic { @GetMapping("/wrong") String x(); }
    @FeignClient(name="b", configuration=Custom.class) interface CustomUse { @GetMapping("/wrong") String x(); }
  `;
  assert.deepEqual(summarize(parseEndpointContracts(source)),[['feign','unresolved','',null],['feign','unresolved','',null]]);
});

test('MVC browsing preserves literal mappings and explains unresolved keyed paths without inventing their prefix', () => {
  const source = '@RestController class Controller { @GetMapping(path="/wrong" + SUFFIX) String dynamic(){} @GetMapping(path={"/a","/b",}) String literal(){} }';
  assert.deepEqual(summarize(sourceEndpoints(source)),[
    ['mvc','unresolved','GET',null],['mvc','declared','GET','/a'],['mvc','declared','GET','/b']
  ]);
});
