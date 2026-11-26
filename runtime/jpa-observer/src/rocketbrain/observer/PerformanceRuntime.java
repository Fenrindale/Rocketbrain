package rocketbrain.observer;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.lang.ref.WeakReference;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.JDBCType;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

/** Short, opt-in request samples. Neither bind values nor raw request URLs enter snapshots. */
public final class PerformanceRuntime {
    private static final int MAX_REQUESTS=12, MAX_SELECTS=40, MAX_SQL=768, MAX_LOADERS=12, MAX_BINDS=16;
    private static final Pattern SQL_TOKEN=Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*|`[A-Za-z_$][A-Za-z0-9_$]*`|[?.,()=*<>!+/\\-% ]");
    private static final Pattern SQL_NAME=Pattern.compile("(?:[A-Za-z_$][A-Za-z0-9_$]*|`[A-Za-z_$][A-Za-z0-9_$]*`)(?:\\.(?:[A-Za-z_$][A-Za-z0-9_$]*|`[A-Za-z_$][A-Za-z0-9_$]*`)){0,2}");
    private static final Pattern JAVA_NAME=Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)+");
    private static final Pattern ROUTE=Pattern.compile("/[A-Za-z0-9/_{}*.:\\-]{0,159}");
    private static final Set<String> METHODS=Set.of("GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS","TRACE");
    private static final String ASYNC_MANAGER_ATTRIBUTE =
        "org.springframework.web.context.request.async.WebAsyncManager.WEB_ASYNC_MANAGER";
    private static final long ASYNC_LIMIT = TimeUnit.SECONDS.toNanos(30);
    private static final List<Capture> asyncRequests = new ArrayList<>();
    private static final ThreadLocal<Request> request=new ThreadLocal<>();
    private static final Semaphore active=new Semaphore(32);
    private static final AtomicLong sequence=new AtomicLong(), omittedRequests=new AtomicLong();
    private static final ArrayDeque<Map<String,Object>> samples=new ArrayDeque<>();
    private static final SecureRandom random=new SecureRandom();
    private static volatile boolean enabled;

    private PerformanceRuntime(){}
    static void configure(boolean requested){enabled=requested;}
    static boolean enabled(){return enabled;}

    private record CollectionLoad(Object session,String role,String entity,String owner,String table,List<String> keyColumns,int key){}
    private static final CollectionLoad opaque=new CollectionLoad(null,null,null,null,null,null,0);
    private enum Phase {
        INITIAL("request"), WORKER("callable-worker"), REDISPATCH("async-dispatch"), OTHER("unattributed-dispatch");
        final String label;
        Phase(String label){this.label=label;}
    }

    private static final class Capture {
        final long id=sequence.incrementAndGet(), started=System.nanoTime();
        final String startedAt=Instant.now().toString();
        final List<Map<String,Object>> selects=new ArrayList<>();
        final List<WeakReference<Object>> sessions=new ArrayList<>();
        final Map<ByteBuffer,Integer> keys=new HashMap<>();
        byte[] salt;
        int omitted, graphSize, omittedGraphApplications;

        // These lifecycle fields belong to the asyncRequests lock.
        WeakReference<Object> manager;
        String method, route;
        boolean initialDone, workerStarted, workerEnded, workerReturned, workerResult, resultAccepted;
        boolean redispatchStarted, redispatchDone, incomplete;
        volatile boolean finished;

        int sessionId(Object session){
            for(int i=0;i<sessions.size();i++){
                if(sessions.get(i).get()==session)return i+1;
            }
            sessions.add(new WeakReference<>(session));
            return sessions.size();
        }
    }

    private static final class Request {
        final Capture capture;
        final Phase phase;
        final Object servletRequest;
        final ArrayDeque<CollectionLoad> loads=new ArrayDeque<>();
        final ArrayDeque<BindFrame> bindFrames=new ArrayDeque<>();
        int depth=1, loadDepth, selectDepth;
        boolean incomplete, callableReturned;
        Request(Capture capture,Phase phase,Object servletRequest){
            this.capture=capture;this.phase=phase;this.servletRequest=servletRequest;
        }
        boolean balanced(){return !incomplete&&depth==1&&loadDepth==0&&selectDepth==0;}
    }
    private record Binding(String jdbcType,String source){}
    private static final class BindFrame {
        final Binding[] positions=new Binding[MAX_BINDS];
        WeakReference<Object> statement;
        boolean binding,bound,outOfRange;
    }

    private static String dispatcher(Object servletRequest){
        Object value=HibernateAccess.optional(servletRequest,"getDispatcherType");
        return value instanceof Enum<?> enumeration?enumeration.name():"";
    }

    private static Object asyncManager(Object servletRequest){
        return HibernateAccess.optional(servletRequest,"getAttribute",ASYNC_MANAGER_ATTRIBUTE);
    }

    public static void requestStart(Object servletRequest){
        try{
            if(!enabled)return;
            Request prior=request.get();
            if(prior!=null){prior.depth++;prior.incomplete=true;return;}
            String dispatch=dispatcher(servletRequest);
            Object manager=dispatch.equals("ASYNC")?asyncManager(servletRequest):null;
            synchronized(asyncRequests){
                retireAsyncRequests();
                Capture linked=findAsync(manager);
                if(linked!=null&&linked.resultAccepted&&!linked.redispatchStarted){
                    linked.redispatchStarted=true;
                    request.set(new Request(linked,Phase.REDISPATCH,servletRequest));
                    return;
                }
                if(linked!=null)linked.incomplete=true;
            }
            if(!active.tryAcquire()){omittedRequests.incrementAndGet();return;}
            try{request.set(new Request(new Capture(),dispatch.equals("REQUEST")?Phase.INITIAL:Phase.OTHER,servletRequest));}
            catch(Throwable failure){active.release();omittedRequests.incrementAndGet();}
        }catch(Throwable ignored){}
    }

    public static void requestEnd(boolean success){
        try{
            Request current=request.get();
            if(current==null)return;
            if(current.depth>1){current.depth--;return;}
            request.remove();
            Capture capture=current.capture;
            Object method=HibernateAccess.optional(current.servletRequest,"getMethod");
            Object route=HibernateAccess.optional(current.servletRequest,"getAttribute","org.springframework.web.servlet.HandlerMapping.bestMatchingPattern");
            if(route!=null&&route.getClass().getName().equals("org.springframework.web.util.pattern.PathPattern")){
                route=HibernateAccess.optional(route,"getPatternString");
            }
            var async=HibernateAccess.optional(current.servletRequest,"isAsyncStarted");
            synchronized(asyncRequests){
                if(capture.finished)return;
                if(capture.method==null&&method instanceof String value&&METHODS.contains(value))capture.method=value;
                if(capture.route==null&&route instanceof String value&&ROUTE.matcher(value).matches())capture.route=value;
                capture.incomplete|=!success||!current.balanced();
                if(current.phase==Phase.INITIAL&&capture.manager!=null){
                    capture.initialDone=true;
                    finishWhenReady(capture);
                }else if(current.phase==Phase.REDISPATCH){
                    capture.redispatchDone=true;
                    capture.incomplete|=!Boolean.FALSE.equals(async);
                    finishWhenReady(capture);
                }else{
                    boolean synchronous=current.phase==Phase.INITIAL&&Boolean.FALSE.equals(async);
                    publish(capture,synchronous?"synchronous":"unattributed",synchronous);
                }
            }
        }catch(Throwable ignored){}
    }

    public static void callableScheduled(Object manager){
        try{
            Request current=request.get();
            // Check the original Spring-managed request instead of propagating every executor task.
            if(current==null||current.phase!=Phase.INITIAL||asyncManager(current.servletRequest)!=manager)return;
            synchronized(asyncRequests){
                Capture capture=current.capture;
                if(capture.finished)return;
                if(capture.manager!=null||findAsync(manager)!=null){capture.incomplete=true;return;}
                capture.manager=new WeakReference<>(manager);
                asyncRequests.add(capture);
            }
        }catch(Throwable ignored){}
    }

    public static Object callableWorkerStart(Object manager){
        try{
            synchronized(asyncRequests){
                retireAsyncRequests();
                Capture capture=findAsync(manager);
                if(capture==null||capture.resultAccepted)return null;
                if(request.get()!=null||capture.workerStarted){capture.incomplete=true;return null;}
                capture.workerStarted=true;
                Request worker=new Request(capture,Phase.WORKER,null);
                request.set(worker);
                return worker;
            }
        }catch(Throwable ignored){return null;}
    }

    public static void callableReturned(Object token){
        try{if(token instanceof Request worker&&request.get()==worker)worker.callableReturned=true;}
        catch(Throwable ignored){}
    }

    public static void callableAccepted(Object manager,Object result){
        try{
            synchronized(asyncRequests){
                Capture capture=findAsync(manager);
                if(capture==null)return;
                Request current=request.get();
                capture.resultAccepted=true;
                capture.workerResult=current!=null&&current.capture==capture&&current.phase==Phase.WORKER&&
                    current.callableReturned&&!(result instanceof Throwable);
            }
        }catch(Throwable ignored){}
    }

    public static void callableWorkerEnd(Object token,boolean success){
        try{
            if(!(token instanceof Request worker)||request.get()!=worker)return;
            request.remove();
            synchronized(asyncRequests){
                Capture capture=worker.capture;
                if(capture.finished)return;
                capture.workerEnded=true;
                capture.workerReturned=success&&worker.callableReturned&&worker.balanced();
                finishWhenReady(capture);
            }
        }catch(Throwable ignored){}
    }

    private static Capture findAsync(Object manager){
        if(manager!=null)for(Capture capture:asyncRequests)if(capture.manager.get()==manager)return capture;
        return null;
    }

    private static void finishWhenReady(Capture capture){
        if(capture.initialDone&&capture.redispatchDone&&capture.resultAccepted&&(!capture.workerResult||capture.workerEnded)){
            publish(capture,"spring-mvc-callable",capture.workerResult&&capture.workerReturned);
        }
    }

    private static void retireAsyncRequests(){
        // A weak manager identity and a hard age bound cover requests with no redispatch.
        long now=System.nanoTime();
        for(int i=asyncRequests.size()-1;i>=0;i--){
            Capture capture=asyncRequests.get(i);
            if(capture.manager.get()==null||now-capture.started>=ASYNC_LIMIT)publish(capture,"spring-mvc-callable",false);
        }
    }

    private static void publish(Capture capture,String dispatch,boolean complete){
        if(capture.finished)return;
        asyncRequests.remove(capture);
        try{
            synchronized(capture){
                capture.finished=true;
                if(capture.selects.isEmpty()&&capture.omitted==0)return;
                Map<String,Object> sample=new LinkedHashMap<>();
                sample.put("id",capture.id);sample.put("startedAt",capture.startedAt);
                sample.put("durationMicros",TimeUnit.NANOSECONDS.toMicros(System.nanoTime()-capture.started));
                sample.put("dispatch",dispatch);
                sample.put("complete",complete&&!capture.incomplete&&capture.omitted==0);
                if(capture.method!=null)sample.put("method",capture.method);
                if(capture.route!=null)sample.put("route",capture.route);
                sample.put("selects",List.copyOf(capture.selects));
                sample.put("omittedSelects",capture.omitted);
                sample.put("omittedGraphApplications",capture.omittedGraphApplications);
                synchronized(samples){
                    if(samples.size()>=MAX_REQUESTS){samples.removeFirst();omittedRequests.incrementAndGet();}
                    samples.addLast(Map.copyOf(sample));
                }
            }
        }finally{
            synchronized(capture){
                // Timed-out application work may still hold its frame.
                capture.selects.clear();
                capture.sessions.clear();
                capture.keys.clear();
                capture.salt=null;
            }
            active.release();
        }
    }

    private static String safeName(Object value,Pattern pattern){
        return value instanceof String text&&text.length()<=192&&pattern.matcher(text).matches()?text:null;
    }

    public static void collectionStart(Object loader,Object key,Object session){
        try{
            Request current=request.get();
            if(current==null||current.capture.finished)return;
            if(++current.loadDepth>MAX_LOADERS){current.incomplete=true;return;}
            CollectionLoad load=opaque;
            try{
                Object mapping=HibernateAccess.optional(loader,"getLoadable");
                Object collection=HibernateAccess.optional(mapping,"getCollectionDescriptor");
                Object owner=HibernateAccess.optional(collection,"getOwnerEntityPersister");
                String role=safeName(HibernateAccess.optional(collection,"getRole"),JAVA_NAME);
                Object ownerClass=HibernateAccess.optional(owner,"getMappedClass");
                String entity=ownerClass instanceof Class<?> type?safeName(type.getName(),JAVA_NAME):null;
                String parent=safeName(HibernateAccess.optional(owner,"getRootTableName"),SQL_NAME);
                String child=safeName(HibernateAccess.optional(collection,"getTableName"),SQL_NAME);
                List<String> columns=keyColumns(collection);
                Object[] values=keyParts(collection,key,columns.size());
                int id=values==null?0:keyOrdinal(current.capture,values);
                if(session!=null&&role!=null&&entity!=null&&parent!=null&&child!=null&&!columns.isEmpty()&&id>0){
                    load=new CollectionLoad(session,role,entity,parent,child,columns,id);
                }
            }catch(Throwable ignored){}
            finally{
                current.loads.push(load);
            }
        }catch(Throwable ignored){}
    }

    public static void collectionEnd(){
        try{
            Request current=request.get();
            if(current==null||current.loadDepth<=0)return;
            if(current.loadDepth--<=MAX_LOADERS)current.loads.poll();
        }catch(Throwable ignored){}
    }

    private static List<String> keyColumns(Object collection){
        Object result=HibernateAccess.optional(collection,"getKeyColumnNames");
        if(!(result instanceof String[] names)||names.length<1||names.length>4)return List.of();
        List<String> columns=new ArrayList<>(names.length);
        for(String value:names){
            String name=safeName(value,SQL_NAME);
            if(name==null||name.indexOf('.')>=0||columns.contains(name))return List.of();
            columns.add(name);
        }
        return List.copyOf(columns);
    }

    private static Object[] keyParts(Object collection,Object key,int columns){
        if(columns==1)return new Object[]{key};
        if(columns<2||key==null)return null;
        Object type=HibernateAccess.optional(collection,"getKeyType");
        if(type==null||!type.getClass().getName().equals("org.hibernate.type.ComponentType"))return null;
        Object result=HibernateAccess.optional(type,"getPropertyValues",key);
        return result instanceof Object[] parts&&parts.length==columns?parts:null;
    }

    private static void appendPart(MessageDigest digest,byte[] value){
        digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(value.length).array());
        digest.update(value);
    }

    private static int keyOrdinal(Capture capture,Object[] parts)throws Exception{
        synchronized(capture){
            if(capture.finished)return 0;
            if(capture.salt==null){capture.salt=new byte[24];random.nextBytes(capture.salt);}
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            digest.update(capture.salt);
            digest.update((byte)parts.length);
            for(Object key:parts){
                String rendered;
                if(key instanceof String text&&text.length()<=128)rendered=text;
                else if(key instanceof Long||key instanceof Integer||key instanceof Short||key instanceof Byte||key instanceof UUID)rendered=key.toString();
                else return 0;
                appendPart(digest,key.getClass().getName().getBytes(StandardCharsets.US_ASCII));
                appendPart(digest,rendered.getBytes(StandardCharsets.UTF_8));
            }
            ByteBuffer fingerprint=ByteBuffer.wrap(digest.digest());
            Integer previous=capture.keys.get(fingerprint);
            if(previous!=null)return previous;
            if(capture.keys.size()>=MAX_SELECTS)return 0;
            int ordinal=capture.keys.size()+1;
            capture.keys.put(fingerprint,ordinal);
            return ordinal;
        }
    }

    private static String shape(String raw){
        if(raw==null||raw.length()>MAX_SQL)return null;
        String sql=raw.trim().replaceAll("\\s+"," ");
        if(sql.length()<8||!sql.regionMatches(true,0,"select ",0,7)||sql.contains("/*")||sql.contains("--"))return null;
        var matcher=SQL_TOKEN.matcher(sql);
        int at=0;
        while(matcher.find()){
            if(matcher.start()!=at)return null;
            at=matcher.end();
        }
        return at==sql.length()?sql:null;
    }

    public static void selectStart(){
        try{
            Request current=request.get();
            if(current!=null&&!current.capture.finished&&++current.selectDepth<=MAX_LOADERS)current.bindFrames.push(new BindFrame());
        }catch(Throwable ignored){}
    }

    public static void selectEnd(){
        try{
            Request current=request.get();
            if(current!=null&&current.selectDepth>0&&current.selectDepth--<=MAX_LOADERS)current.bindFrames.poll();
        }catch(Throwable ignored){}
    }

    private static BindFrame bindFrame(Request current){
        return current!=null&&current.selectDepth>0&&current.selectDepth<=MAX_LOADERS?current.bindFrames.peek():null;
    }

    public static void bindStart(Object statement){
        try{
            BindFrame frame=bindFrame(request.get());
            if(frame!=null){
                frame.statement=new WeakReference<>(statement);
                frame.binding=true;
            }
        }catch(Throwable ignored){}
    }

    public static void bindEnd(){
        try{
            BindFrame frame=bindFrame(request.get());
            if(frame!=null){
                frame.binding=false;
                frame.bound=true;
            }
        }catch(Throwable ignored){}
    }

    public static void typedBind(Object statement,int index,int type){recordBind(statement,index,type,"setter");}
    public static void explicitBind(Object statement,int index,int type){recordBind(statement,index,type,"explicit");}
    public static void explicitBindType(Object statement,int index,Object type){
        if(type instanceof JDBCType jdbc)explicitBind(statement,index,jdbc.getVendorTypeNumber());
        else untypedBind(statement,index);
    }
    public static void untypedBind(Object statement,int index){recordBind(statement,index,0,"untyped");}

    public static void clearBinds(Object statement){
        try{
            BindFrame frame=bindFrame(request.get());
            if(frame!=null&&frame.binding&&frame.statement!=null&&frame.statement.get()==statement){
                Arrays.fill(frame.positions,null);
                frame.outOfRange=false;
            }
        }catch(Throwable ignored){}
    }

    private static void recordBind(Object statement,int index,int code,String source){
        try{
            BindFrame frame=bindFrame(request.get());
            if(frame==null||!frame.binding||frame.statement==null||frame.statement.get()!=statement)return;
            if(index<1||index>MAX_BINDS){frame.outOfRange=true;return;}
            String type=null;
            if(code!=0){
                try{type=JDBCType.valueOf(code).name();}catch(IllegalArgumentException unrecognized){}
            }
            frame.positions[index-1]=new Binding(type,type==null?"untyped":source);
        }catch(Throwable ignored){}
    }

    private static Map<String,Object> bindings(Request current,Object statement,String sql){
        // shape() admits no string literals, comments or '?' inside identifiers.
        int count=(int)sql.chars().filter(character->character=='?').count();
        BindFrame frame=bindFrame(current);
        if(frame==null||!frame.bound||frame.statement==null||frame.statement.get()!=statement){
            return Map.of("state","unavailable","placeholders",count,"positions",List.of());
        }
        boolean complete=count<=MAX_BINDS&&!frame.outOfRange;
        List<Map<String,Object>> positions=new ArrayList<>();
        for(int index=0;index<Math.min(count,MAX_BINDS);index++){
            Binding binding=frame.positions[index];
            if(binding==null||binding.jdbcType==null)complete=false;
            if(binding!=null)positions.add(binding.jdbcType==null?Map.of("index",index+1,"source","untyped"):
                Map.of("index",index+1,"jdbcType",binding.jdbcType,"source",binding.source));
        }
        return Map.of("state",complete?"complete":"partial","placeholders",count,"positions",List.copyOf(positions));
    }

    public static void selectExecuted(Object statement,Object context,String raw,long elapsed){
        try{
            Request current=request.get();
            if(current==null)return;
            Object session=HibernateAccess.optional(context,"getSession");
            String sql=shape(raw);
            var entityGraph=sql==null||session==null?null:appliedGraph(session,context);
            int graphSize=entityGraph==null?0:Json.encode(entityGraph).length();
            Capture capture=current.capture;
            synchronized(capture){
                if(capture.finished)return;
                if(session==null||sql==null||capture.selects.size()>=MAX_SELECTS){capture.omitted++;return;}
                int id=capture.selects.size()+1, sessionId=capture.sessionId(session);
                Map<String,Object> entry=new LinkedHashMap<>();
                entry.put("sequence",id);entry.put("session",sessionId);entry.put("sql",sql);
                entry.put("phase",current.phase.label);
                entry.put("durationMicros",TimeUnit.NANOSECONDS.toMicros(elapsed));
                entry.put("binds",bindings(current,statement,sql));
                if(entityGraph!=null){
                    if(capture.graphSize+graphSize<=4096){
                        entry.put("entityGraph",entityGraph);
                        capture.graphSize+=graphSize;
                    }else capture.omittedGraphApplications++;
                }
                CollectionLoad load=current.loads.peek();
                if(current.loadDepth>0&&(load==null||load.session!=session)){
                    current.incomplete=true;
                }else if(load!=null){
                    Map<String,Object> identified=new LinkedHashMap<>();
                    identified.put("role",load.role);identified.put("entity",load.entity);identified.put("ownerTable",load.owner);
                    identified.put("childTable",load.table);identified.put("key",load.key);
                    if(load.keyColumns.size()==1)identified.put("keyColumn",load.keyColumns.get(0));
                    else identified.put("keyColumns",load.keyColumns);
                    entry.put("collection",Map.copyOf(identified));
                }
                capture.selects.add(Map.copyOf(entry));
            }
        }catch(Throwable ignored){}
    }

    private static Map<String,Object> appliedGraph(Object session,Object context){
        try{
            if(!Set.of("org.hibernate.internal.SessionImpl","org.hibernate.internal.StatelessSessionImpl").contains(session.getClass().getName()))return null;
            Object factory=HibernateAccess.optional(session,"getFactory");
            Map<String,Object> graph=HibernateAccess.appliedEntityGraph(factory,context);
            if(graph==null)return null;
            String id=ObserverRuntime.registerFactory(factory);
            if(id==null)return null;
            graph.put("factoryId",id);
            return Map.copyOf(graph);
        }catch(Throwable ignored){return null;}
    }

    private static List<Map<String,Object>> retainedSamples(){
        synchronized(asyncRequests){retireAsyncRequests();}
        synchronized(samples){return List.copyOf(samples);}
    }

    static Map<String,Object> graphApplications(String factoryId,List<String> instruments){
        boolean available=enabled&&instruments.containsAll(List.of(PerformanceTransformer.MVC,PerformanceTransformer.JDBC));
        List<Map<String,Object>> applications=new ArrayList<>();
        if(available)for(Map<String,Object> sample:retainedSamples()){
            @SuppressWarnings("unchecked")
            List<Map<String,Object>> selects=(List<Map<String,Object>>)sample.get("selects");
            for(Map<String,Object> select:selects){
                if(!(select.get("entityGraph") instanceof Map<?,?> graph)||!factoryId.equals(graph.get("factoryId")))continue;
                Map<String,Object> result=new LinkedHashMap<>();
                result.put("requestId",sample.get("id"));
                result.put("completeRequest",sample.get("complete"));
                if(sample.containsKey("route"))result.put("route",sample.get("route"));
                result.put("select",select.get("sequence"));
                result.put("phase",select.get("phase"));
                result.put("applied",graph);
                applications.add(Map.copyOf(result));
            }
        }
        return Map.of("state",available?"observed":enabled?"awaiting-supported-hooks":"disabled","applications",List.copyOf(applications));
    }

    static Map<String,Object> snapshot(List<String> instruments){
        List<Map<String,Object>> retained=retainedSamples();
        return Map.ofEntries(
            Map.entry("enabled",enabled),Map.entry("scope","spring-mvc"),
            Map.entry("available",enabled&&instruments.containsAll(List.of(PerformanceTransformer.MVC,PerformanceTransformer.LOADER,PerformanceTransformer.JDBC))),
            Map.entry("maxRequests",MAX_REQUESTS),Map.entry("maxSelectsPerRequest",MAX_SELECTS),Map.entry("omittedRequests",omittedRequests.get()),
            Map.entry("requests",retained),Map.entry("rawBindValuesRetained",false),Map.entry("observerExecutedSql",false),
            Map.entry("bindObservation","hibernate-jdbc-setters-v1"),
            Map.entry("entityGraphObservation","hibernate-applied-query-graph-v1"),
            Map.entry("callableObservation",enabled&&instruments.contains(PerformanceTransformer.ASYNC)));
    }
}
