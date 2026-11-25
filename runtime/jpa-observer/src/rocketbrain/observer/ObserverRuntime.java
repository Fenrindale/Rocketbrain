package rocketbrain.observer;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.lang.ref.WeakReference;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/** Calls injected into Hibernate; every hook fails closed without changing application exceptions. */
public final class ObserverRuntime {
    public static final String VERSION="0.14.0";
    private static volatile HttpServer server;private static volatile ThreadPoolExecutor executor;
    private static byte[] expectedAuthorization;private static boolean queries,validate,consoleSelect,consoleFetchSnapshots;private static int maxEvents=128,maxQueryChars=4096;
    private static final ArrayDeque<Map<String,Object>> events=new ArrayDeque<>();private static final List<String> warnings=new ArrayList<>(),instrumented=new ArrayList<>();
    private static final List<Factory> factories=new ArrayList<>();private static final AtomicLong ids=new AtomicLong(),eventIds=new AtomicLong();private static long dropped;
    private static final ThreadLocal<Frame> queryFrames=new ThreadLocal<>(),translationFrames=new ThreadLocal<>();private static final ThreadLocal<Origin> origins=new ThreadLocal<>();private static final Semaphore requests=new Semaphore(2),consoleRequests=new Semaphore(1);
    private ObserverRuntime(){}
    private record Factory(String id,WeakReference<Object> value){}
    private record Origin(String kind,String factoryId){}
    private static final class Frame {int depth=1;final String query,factoryId,origin;final long started=System.nanoTime();Frame(String query,String factoryId,String origin){this.query=query;this.factoryId=factoryId;this.origin=origin;}}
    static synchronized void start(Map<String,Object> config)throws Exception {
        Set<String> allowed=Set.of("tokenFile","descriptorFile","port","queries","validate","maxEvents","maxQueryChars","performance","consoleSelect","consoleFetchSnapshots","securityTrace","securityMethodTrace","securityTraceRoles","securityReactiveTrace","feignContractTrace");if(!allowed.containsAll(config.keySet()))throw new IllegalArgumentException("Unknown observer option");
        Path tokenPath=Path.of(requiredText(config,"tokenFile"));if(!tokenPath.isAbsolute()||!Files.isRegularFile(tokenPath,LinkOption.NOFOLLOW_LINKS)||Files.size(tokenPath)>256)throw new IllegalArgumentException("Invalid token file");
        String token=Files.readString(tokenPath,StandardCharsets.UTF_8).trim();if(!token.matches("[A-Za-z0-9_-]{32,128}"))throw new IllegalArgumentException("Invalid bearer token");expectedAuthorization=("Bearer "+token).getBytes(StandardCharsets.US_ASCII);
        queries=flag(config,"queries");validate=flag(config,"validate");consoleSelect=flag(config,"consoleSelect");PerformanceRuntime.configure(flag(config,"performance"));maxEvents=integer(config,"maxEvents",128,1,256);maxQueryChars=integer(config,"maxQueryChars",4096,64,16384);int port=integer(config,"port",0,0,65535);
        consoleFetchSnapshots=flag(config,"consoleFetchSnapshots")&&consoleSelect;
        SecurityTraceRuntime.configure(flag(config,"securityTrace"));
        ReactiveSecurityTrace.configure(flag(config,"securityReactiveTrace"));
        FeignContractTrace.configure(flag(config,"feignContractTrace"));
        MethodSecurityTrace.configure(flag(config,"securityMethodTrace")&&SecurityTraceRuntime.enabled(),config.get("securityTraceRoles"));
        HttpServer next=HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"),port),8);
        executor=new ThreadPoolExecutor(2,2,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(8),r->{Thread thread=new Thread(r,"Rocketbrain JPA observer");thread.setDaemon(true);return thread;},new ThreadPoolExecutor.AbortPolicy());
        next.setExecutor(executor);next.createContext("/",ObserverRuntime::handle);server=next;
        // HttpServer's dispatcher inherits daemon status: the observer must not keep an app alive.
        Thread starter=new Thread(next::start,"Rocketbrain observer starter");starter.setDaemon(true);starter.start();starter.join();
        Map<String,Object> descriptor=new LinkedHashMap<>();descriptor.put("agentVersion",VERSION);descriptor.put("baseUrl","http://127.0.0.1:"+next.getAddress().getPort());descriptor.put("processId",ProcessHandle.current().pid());descriptor.put("queryEvents",queries);descriptor.put("semanticValidation",validate);descriptor.put("consoleSelectEnabled",consoleSelect);descriptor.put("performanceCapture",PerformanceRuntime.enabled());descriptor.put("javaFeature",Runtime.version().feature());
        descriptor.put("consoleFetchSnapshotsEnabled",consoleFetchSnapshots);
        descriptor.put("securityTraceEnabled",SecurityTraceRuntime.enabled());
        descriptor.put("securityReactiveTraceEnabled",ReactiveSecurityTrace.enabled());
        descriptor.put("feignContractTraceEnabled",FeignContractTrace.enabled());
        descriptor.put("securityMethodTraceEnabled",MethodSecurityTrace.enabled());
        if(config.containsKey("descriptorFile")){Path path=Path.of(requiredText(config,"descriptorFile"));if(!path.isAbsolute()||!Files.isDirectory(path.getParent(),LinkOption.NOFOLLOW_LINKS))throw new IllegalArgumentException("Invalid descriptor path");Files.writeString(path,Json.encode(descriptor),StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE);}
        Runtime.getRuntime().addShutdownHook(new Thread(ObserverRuntime::stop,"Rocketbrain observer shutdown"));
        System.out.println("ROCKETBRAIN_JPA_OBSERVER "+Json.encode(descriptor));
    }
    static synchronized void stop(){if(server!=null){server.stop(0);server=null;}if(executor!=null){executor.shutdownNow();executor=null;}expectedAuthorization=null;PerformanceRuntime.configure(false);MethodSecurityTrace.configure(false,null);SecurityTraceRuntime.configure(false);ReactiveSecurityTrace.configure(false);FeignContractTrace.configure(false);}
    private static String requiredText(Map<String,Object> map,String key){Object value=map.get(key);if(!(value instanceof String text)||text.isBlank()||text.length()>8192)throw new IllegalArgumentException("Text option required");return text;}
    private static boolean flag(Map<String,Object> config,String key){Object value=config.get(key);if(value!=null&&!(value instanceof Boolean))throw new IllegalArgumentException("Boolean option required");return Boolean.TRUE.equals(value);}
    private static int integer(Map<String,Object> map,String key,int fallback,int min,int max){Object value=map.getOrDefault(key,(long)fallback);if(!(value instanceof Number number)||number.longValue()<min||number.longValue()>max)throw new IllegalArgumentException("Numeric option outside limits");return number.intValue();}
    static synchronized void warning(String warning){if(warnings.size()<32&&!warnings.contains(warning))warnings.add(cut(warning,256));}
    static synchronized void instrumented(String type){if(!instrumented.contains(type))instrumented.add(type);}
    private static String cut(String value,int limit){return value==null?null:value.substring(0,Math.min(value.length(),limit));}
    private static String captureFactory(Object session){
        try{return registerFactory(publicMethod(session.getClass(),"getFactory").invoke(session));}
        catch(Throwable ignored){warning("Session factory public API unavailable");return null;}
    }
    private static synchronized String registerFactory(Object factory){if(factory==null)return null;factories.removeIf(f->f.value.get()==null);for(Factory entry:factories)if(entry.value.get()==factory)return entry.id;if(factories.size()>=4){warning("Factory limit reached");return null;}String id="factory-"+ids.incrementAndGet();factories.add(new Factory(id,new WeakReference<>(factory)));return id;}
    public static void factorySeen(Object factory){try{registerFactory(factory);}catch(Throwable ignored){}}
    public static synchronized void factoryClosed(Object factory){try{factories.removeIf(entry->entry.value.get()==factory);}catch(Throwable ignored){}}
    private static Method publicMethod(Class<?> type,String name)throws NoSuchMethodException {
        if(Modifier.isPublic(type.getModifiers())){try{Method method=type.getMethod(name);if(Modifier.isPublic(method.getDeclaringClass().getModifiers()))return method;}catch(NoSuchMethodException ignored){}}
        for(Class<?> parent:type.getInterfaces())try{return publicMethod(parent,name);}catch(NoSuchMethodException ignored){}
        if(type.getSuperclass()!=null)return publicMethod(type.getSuperclass(),name);throw new NoSuchMethodException(name);
    }
    public static void queryStart(Object session,String query){try{if(consoleOrigin())return;String factoryId=captureFactory(session);if(!queries)return;Frame current=queryFrames.get();if(current!=null){current.depth++;return;}Origin origin=origins.get();queryFrames.set(new Frame(cut(query,maxQueryChars),factoryId,origin==null?"application":origin.kind));}catch(Throwable ignored){}}
    public static void querySuccess(Object query){try{finish(queryFrames,"query-create","created",query==null?Map.of():Map.of("queryClass",query.getClass().getName()),null);}catch(Throwable ignored){}}
    public static void queryFailure(Throwable error){try{finish(queryFrames,"query-create","rejected",Map.of(),error);}catch(Throwable ignored){}}
    private static boolean consoleOrigin(){Origin origin=origins.get();return origin!=null&&origin.kind.equals("explicit-jpql-console");}
    public static void translationStart(String query){try{if(!queries||consoleOrigin())return;Frame current=translationFrames.get();if(current!=null){current.depth++;return;}Frame parent=queryFrames.get();Origin origin=origins.get();translationFrames.set(new Frame(cut(query,maxQueryChars),parent!=null?parent.factoryId:origin==null?null:origin.factoryId,parent!=null?parent.origin:origin==null?"application":origin.kind));}catch(Throwable ignored){}}
    public static void translationSuccess(Object statement){try{Frame current=translationFrames.get();if(current==null)return;Map<String,Object> metadata=current.depth==1?HibernateAccess.describeStatement(statement):Map.of();finish(translationFrames,"hql-translate","translated",metadata,null);}catch(Throwable ignored){translationFrames.remove();}}
    public static void translationFailure(Throwable error){try{finish(translationFrames,"hql-translate","rejected",Map.of(),error);}catch(Throwable ignored){}}
    private static void finish(ThreadLocal<Frame> local,String operation,String state,Map<String,Object> metadata,Throwable error){Frame frame=local.get();if(frame==null)return;if(--frame.depth>0)return;local.remove();Map<String,Object> event=new LinkedHashMap<>();event.put("id",eventIds.incrementAndGet());event.put("at",Instant.now().toString());event.put("operation",operation);event.put("state",state);event.put("origin",frame.origin);event.put("factoryId",frame.factoryId);event.put("query",frame.query);event.put("queryTruncated",frame.query!=null&&frame.query.length()==maxQueryChars);event.put("durationMicros",TimeUnit.NANOSECONDS.toMicros(System.nanoTime()-frame.started));event.put("metadata",metadata);event.put("observerExecutedSql",false);event.put("boundParameterValuesRetained",false);if(error!=null){event.put("errorClass",error.getClass().getName());event.put("message",cut(error.getMessage(),1024));}synchronized(ObserverRuntime.class){if(events.size()>=maxEvents){events.removeFirst();dropped++;}events.addLast(event);}}
    private static Map<String,Object> snapshot(){List<Factory> references;List<Map<String,Object>> captured;List<String> problems,classes;long omitted;synchronized(ObserverRuntime.class){references=List.copyOf(factories);captured=List.copyOf(events);problems=List.copyOf(warnings);classes=List.copyOf(instrumented);omitted=dropped;}
        List<Map<String,Object>> providerMetadata=new ArrayList<>();for(Factory entry:references){Object factory=entry.value.get();if(factory==null)continue;Map<String,Object> item=new LinkedHashMap<>(HibernateAccess.snapshot(factory));item.put("id",entry.id);providerMetadata.add(item);}
        Map<String,Object> result=new LinkedHashMap<>();result.put("schemaVersion",1);result.put("agentVersion",VERSION);result.put("processId",ProcessHandle.current().pid());result.put("state",providerMetadata.isEmpty()?"waiting":"observed");result.put("capturedAt",Instant.now().toString());result.put("capabilities",Map.of("queries",queries,"validate",validate));result.put("queryEventsEnabled",queries);result.put("semanticValidationEnabled",validate);result.put("consoleSelectEnabled",consoleSelect);result.put("consoleFetchSnapshotsEnabled",consoleFetchSnapshots);result.put("factories",providerMetadata);result.put("performance",PerformanceRuntime.snapshot(classes));result.put("events",captured);result.put("droppedEvents",omitted);result.put("instrumentedClasses",classes);result.put("warnings",problems);result.put("boundParameterValuesRetained",false);result.put("observerExecutedSql",false);return result;
    }
    private static Object factory(String selected){synchronized(ObserverRuntime.class){List<Factory> live=factories.stream().filter(f->f.value.get()!=null).toList();if(selected==null&&live.size()==1)return live.getFirst().value.get();for(Factory item:live)if(item.id.equals(selected))return item.value.get();return null;}}
    private static void handle(HttpExchange exchange)throws IOException {boolean acquired=false;try {
        if(!exchange.getRemoteAddress().getAddress().isLoopbackAddress()){reply(exchange,403,Map.of("error","loopback_required"));return;}
        String authorization=exchange.getRequestHeaders().getFirst("Authorization");byte[] expected=expectedAuthorization;if(expected==null||authorization==null||!MessageDigest.isEqual(expected,authorization.getBytes(StandardCharsets.US_ASCII))){reply(exchange,401,Map.of("error","unauthorized"));return;}
        if(exchange.getRequestHeaders().containsKey("Origin")){reply(exchange,403,Map.of("error","browser_origin_not_allowed"));return;}
        if(!(acquired=requests.tryAcquire())){reply(exchange,429,Map.of("error","busy"));return;}
        String path=exchange.getRequestURI().getPath(),method=exchange.getRequestMethod();if(exchange.getRequestURI().getRawQuery()!=null){reply(exchange,400,Map.of("error","query_parameters_not_allowed"));return;}
        if(path.equals("/snapshot")&&method.equals("GET")){reply(exchange,200,snapshot());return;}
        if(path.equals("/security-trace")){
            if(!method.equals("GET")){reply(exchange,405,Map.of("error","unsupported_route_or_method"));return;}
            reply(exchange,200,SecurityTraceRuntime.snapshot());return;
        }
        if(path.equals("/reactive-security-trace")){
            if(!method.equals("GET")){reply(exchange,405,Map.of("error","unsupported_route_or_method"));return;}
            reply(exchange,200,ReactiveSecurityTrace.snapshot());return;
        }
        if(path.equals("/feign-contracts")){
            if(!method.equals("GET")){reply(exchange,405,Map.of("error","unsupported_route_or_method"));return;}
            reply(exchange,200,FeignContractTrace.snapshot());return;
        }
        if(path.equals("/console/describe")||path.equals("/console/select")){
            if(!method.equals("POST")){reply(exchange,405,Map.of("error","unsupported_route_or_method"));return;}
            handleConsole(exchange,path.endsWith("/select"));return;
        }
        if(path.equals("/validate")&&method.equals("POST")){
            if(!validate){reply(exchange,403,Map.of("error","semantic_validation_disabled"));return;}
            String contentType=exchange.getRequestHeaders().getFirst("Content-Type");if(contentType==null||!contentType.toLowerCase(java.util.Locale.ROOT).startsWith("application/json")){reply(exchange,415,Map.of("error","json_required"));return;}
            byte[] bytes=exchange.getRequestBody().readNBytes(32769);if(bytes.length>32768){reply(exchange,413,Map.of("error","request_limit"));return;}
            Map<String,Object> body=Json.object(new String(bytes,StandardCharsets.UTF_8));if(!Set.of("query","factoryId").containsAll(body.keySet()))throw new IllegalArgumentException("Unknown validation option");String query=requiredText(body,"query");if(query.length()>maxQueryChars){reply(exchange,413,Map.of("error","query_limit"));return;}
            String selected=body.containsKey("factoryId")?requiredText(body,"factoryId"):null;Object factory=factory(selected);if(factory==null){reply(exchange,409,Map.of("state","unknown","reason","No unique observed live SessionFactory; create a query in the application or select factoryId."));return;}
            String factoryId=selected;if(factoryId==null)synchronized(ObserverRuntime.class){for(Factory entry:factories)if(entry.value.get()==factory)factoryId=entry.id;}
            origins.set(new Origin("explicit-semantic-validation",factoryId));
            try{Map<String,Object> result=new LinkedHashMap<>(HibernateAccess.analyze(factory,query));result.put("factoryId",factoryId);result.put("origin","explicit-semantic-validation");reply(exchange,200,result);}finally{origins.remove();}
            return;
        }
        reply(exchange,path.equals("/snapshot")||path.equals("/validate")?405:404,Map.of("error","unsupported_route_or_method"));
    }catch(IllegalArgumentException failure){reply(exchange,400,Map.of("error","invalid_bounded_request"));}catch(Throwable failure){reply(exchange,500,Map.of("state","unknown","reason","Provider metadata unavailable","errorClass",failure.getClass().getName()));}finally{if(acquired)requests.release();exchange.close();}}

    private static void handleConsole(HttpExchange exchange,boolean run) throws IOException {
        if(!consoleSelect){reply(exchange,403,Map.of("error","console_select_disabled"));return;}
        String contentType=exchange.getRequestHeaders().getFirst("Content-Type");
        if(contentType==null||!contentType.split(";",2)[0].trim().equalsIgnoreCase("application/json")){
            reply(exchange,415,Map.of("error","json_required"));return;
        }
        byte[] bytes=exchange.getRequestBody().readNBytes(32769);
        if(bytes.length>32768){reply(exchange,413,Map.of("error","request_limit"));return;}
        Map<String,Object> body=Json.object(new String(bytes,StandardCharsets.UTF_8));
        if(!(run?Set.of("query","factoryId","values","limit"):Set.of("query","factoryId")).equals(body.keySet()))
            throw new IllegalArgumentException("Invalid console request options");
        String query=requiredText(body,"query"), id=requiredText(body,"factoryId");
        if(query.length()>Math.min(ConsoleQuery.MAX_QUERY,maxQueryChars)||!id.matches("factory-[1-9][0-9]{0,15}"))
            throw new IllegalArgumentException("Invalid console request bounds");
        Object factory=factory(id);
        if(factory==null){reply(exchange,200,Map.of("state","rejected","code","factory_unavailable"));return;}
        Object requestedLimit=body.get("limit");
        if(run&&(!(requestedLimit instanceof Long limit)||limit<1||limit>ConsoleQuery.MAX_ROWS))
            throw new IllegalArgumentException("Invalid console row limit");
        if(!consoleRequests.tryAcquire()){reply(exchange,429,Map.of("error","console_busy"));return;}
        origins.set(new Origin("explicit-jpql-console",id));
        try {
            ConsoleQuery.Prepared prepared=ConsoleQuery.describe(factory,query,consoleFetchSnapshots);
            Map<String,Object> result=run?ConsoleJdbc.select(factory,prepared,ConsoleQuery.bind(prepared,body.get("values")),((Long)requestedLimit).intValue()):prepared.description();
            result.put("factoryId",id);
            reply(exchange,200,result);
        } catch(ConsoleQuery.Refusal rejected) {
            reply(exchange,200,Map.of("state","rejected","code",rejected.code));
        } catch(Throwable failure) {
            reply(exchange,200,Map.of("state","failed","code","console_execution_failed"));
        } finally {origins.remove();consoleRequests.release();}
    }
    private static void reply(HttpExchange exchange,int status,Object value)throws IOException {byte[] bytes=Json.encode(value).getBytes(StandardCharsets.UTF_8);exchange.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");exchange.getResponseHeaders().set("Cache-Control","no-store");exchange.getResponseHeaders().set("Connection","close");exchange.sendResponseHeaders(status,bytes.length);exchange.getResponseBody().write(bytes);}
}
