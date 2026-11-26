package rocketbrain.observer;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
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
    private static final int MAX_REQUESTS=12, MAX_SELECTS=40, MAX_SQL=768, MAX_LOADERS=12;
    private static final Pattern SQL_TOKEN=Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*|`[A-Za-z_$][A-Za-z0-9_$]*`|[?.,()=*<>!+/\\-% ]");
    private static final Pattern SQL_NAME=Pattern.compile("(?:[A-Za-z_$][A-Za-z0-9_$]*|`[A-Za-z_$][A-Za-z0-9_$]*`)(?:\\.(?:[A-Za-z_$][A-Za-z0-9_$]*|`[A-Za-z_$][A-Za-z0-9_$]*`)){0,2}");
    private static final Pattern JAVA_NAME=Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)+");
    private static final Pattern ROUTE=Pattern.compile("/[A-Za-z0-9/_{}*.:\\-]{0,159}");
    private static final Set<String> METHODS=Set.of("GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS","TRACE");
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
    private static final class Request {
        final Object servletRequest;
        final long id=sequence.incrementAndGet(), started=System.nanoTime();
        final String startedAt=Instant.now().toString();
        final List<Map<String,Object>> selects=new ArrayList<>();
        final IdentityHashMap<Object,Integer> sessions=new IdentityHashMap<>();
        final Map<ByteBuffer,Integer> keys=new HashMap<>();
        final ArrayDeque<CollectionLoad> loads=new ArrayDeque<>();
        byte[] salt;
        int depth=1, loadDepth, omitted;
        boolean incomplete;
        Request(Object servletRequest){this.servletRequest=servletRequest;}
    }

    public static void requestStart(Object servletRequest){
        try{
            if(!enabled)return;
            Request prior=request.get();
            if(prior!=null){prior.depth++;prior.incomplete=true;return;}
            if(!active.tryAcquire()){omittedRequests.incrementAndGet();return;}
            try{request.set(new Request(servletRequest));}
            catch(Throwable failure){active.release();omittedRequests.incrementAndGet();}
        }catch(Throwable ignored){}
    }

    public static void requestEnd(boolean success){
        try{
            Request current=request.get();
            if(current==null||--current.depth>0)return;
            request.remove();
            try{
                if(current.selects.isEmpty()&&current.omitted==0)return;
                Map<String,Object> sample=new LinkedHashMap<>();
                sample.put("id",current.id);sample.put("startedAt",current.startedAt);
                sample.put("durationMicros",TimeUnit.NANOSECONDS.toMicros(System.nanoTime()-current.started));
                Object dispatch=HibernateAccess.optional(current.servletRequest,"getDispatcherType");
                boolean direct=dispatch instanceof Enum<?> value&&value.name().equals("REQUEST");
                sample.put("complete",success&&!current.incomplete&&current.omitted==0&&current.loadDepth==0&&direct&&
                    Boolean.FALSE.equals(HibernateAccess.optional(current.servletRequest,"isAsyncStarted")));
                Object method=HibernateAccess.optional(current.servletRequest,"getMethod");
                if(method instanceof String value&&METHODS.contains(value))sample.put("method",value);
                Object route=HibernateAccess.optional(current.servletRequest,"getAttribute","org.springframework.web.servlet.HandlerMapping.bestMatchingPattern");
                if(route!=null&&route.getClass().getName().equals("org.springframework.web.util.pattern.PathPattern")){
                    route=HibernateAccess.optional(route,"getPatternString");
                }
                if(route instanceof String value&&ROUTE.matcher(value).matches())sample.put("route",value);
                sample.put("selects",List.copyOf(current.selects));
                sample.put("omittedSelects",current.omitted);
                synchronized(samples){
                    if(samples.size()>=MAX_REQUESTS){samples.removeFirst();omittedRequests.incrementAndGet();}
                    samples.addLast(Map.copyOf(sample));
                }
            }finally{active.release();}
        }catch(Throwable ignored){}
    }

    private static String safeName(Object value,Pattern pattern){
        return value instanceof String text&&text.length()<=192&&pattern.matcher(text).matches()?text:null;
    }

    public static void collectionStart(Object loader,Object key,Object session){
        try{
            Request current=request.get();
            if(current==null)return;
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
                int id=values==null?0:keyOrdinal(current,values);
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

    private static int keyOrdinal(Request current,Object[] parts)throws Exception{
        if(current.salt==null){current.salt=new byte[24];random.nextBytes(current.salt);}
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        digest.update(current.salt);
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
        Integer previous=current.keys.get(fingerprint);
        if(previous!=null)return previous;
        if(current.keys.size()>=MAX_SELECTS)return 0;
        int ordinal=current.keys.size()+1;
        current.keys.put(fingerprint,ordinal);
        return ordinal;
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

    public static void selectExecuted(Object context,String raw,long elapsed){
        try{
            Request current=request.get();
            if(current==null)return;
            Object session=HibernateAccess.optional(context,"getSession");
            if(session==null||current.selects.size()>=MAX_SELECTS){current.omitted++;return;}
            String sql=shape(raw);
            if(sql==null){current.omitted++;return;}
            int id=current.selects.size()+1,
                sessionId=current.sessions.computeIfAbsent(session,key->current.sessions.size()+1);
            Map<String,Object> entry=new LinkedHashMap<>();
            entry.put("sequence",id);entry.put("session",sessionId);entry.put("sql",sql);
            entry.put("durationMicros",TimeUnit.NANOSECONDS.toMicros(elapsed));
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
            current.selects.add(Map.copyOf(entry));
        }catch(Throwable ignored){}
    }

    static Map<String,Object> snapshot(List<String> instruments){
        List<Map<String,Object>> retained;
        synchronized(samples){retained=List.copyOf(samples);}
        return Map.of("enabled",enabled,"scope","synchronous-spring-mvc",
            "available",enabled&&instruments.containsAll(List.of(PerformanceTransformer.MVC,PerformanceTransformer.LOADER,PerformanceTransformer.JDBC)),
            "maxRequests",MAX_REQUESTS,"maxSelectsPerRequest",MAX_SELECTS,"omittedRequests",omittedRequests.get(),
            "requests",retained,"rawBindValuesRetained",false,"observerExecutedSql",false);
    }
}
