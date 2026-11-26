package rocketbrain.observer;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/** Bounded servlet filter evidence. No URI, authentication, request value or filter instance is retained in history. */
public final class SecurityTraceRuntime {
    private static final int MAX_SAMPLES=32, MAX_MATCHES=16, MAX_FILTERS=32;
    private static final String DEFAULT_CHAIN="org.springframework.security.web.DefaultSecurityFilterChain";
    private static final String OBSERVATION_FILTER="org.springframework.security.web.ObservationFilterChainDecorator$ObservationFilter";
    private static final Set<String> METHODS=Set.of("GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS","TRACE","CONNECT");
    private static final Set<String> FILTER_LISTS=Set.of("java.util.ArrayList","java.util.Collections$EmptyList",
        "java.util.ImmutableCollections$List12","java.util.ImmutableCollections$ListN");
    private static final ThreadLocal<Trace> current=new ThreadLocal<>();
    private static final ArrayDeque<Map<String,Object>> recent=new ArrayDeque<>();
    private static final Set<String> hooks=new LinkedHashSet<>();
    private static final AtomicLong ids=new AtomicLong();
    private static volatile boolean enabled;
    private static long dropped;

    private record Candidate(String chainType,String matcherType) {}
    private static final class Trace {
        final long id=ids.incrementAndGet(), started=System.nanoTime();
        final String method, startedAt=Instant.now().toString();
        final List<Map<String,Object>> matches=new ArrayList<>();
        final List<Object> configured=new ArrayList<>();
        final List<String> entered=new ArrayList<>();
        final MethodSecurityTrace methods=MethodSecurityTrace.enabled()?new MethodSecurityTrace():null;
        final AuthenticationProviderTrace authentication=AuthenticationProviderTrace.enabled()?new AuthenticationProviderTrace():null;
        Candidate pending;
        int depth=1;
        boolean incomplete, selectionSeen;
        Boolean decision;
        Trace(String method){this.method=method;}
    }

    private SecurityTraceRuntime() {}
    static synchronized void configure(boolean option){enabled=option;recent.clear();hooks.clear();dropped=0;}
    static boolean enabled(){return enabled;}
    static synchronized void instrumented(String hook){if(enabled)hooks.add(hook);}

    public static void start(Object request){
        if(!enabled)return;
        try{
            Trace outer=current.get();
            if(outer!=null){outer.depth++;outer.incomplete=true;return;}
            Object dispatch=servlet(request,"jakarta.servlet.ServletRequest","getDispatcherType");
            if(!(dispatch instanceof Enum<?> kind) || !kind.name().equals("REQUEST"))return;
            Object method=servlet(request,"jakarta.servlet.http.HttpServletRequest","getMethod");
            current.set(new Trace(method instanceof String value && METHODS.contains(value)?value:"OTHER"));
        }catch(Throwable ignored){}
    }
    public static void candidate(Object chain){
        Trace trace=outer();if(trace==null)return;
        try{
            if(trace.selectionSeen || trace.pending!=null || trace.matches.size()>=MAX_MATCHES){trace.incomplete=true;return;}
            String chainType=className(chain), matcherType=null;
            if(DEFAULT_CHAIN.equals(chainType))matcherType=className(chain.getClass().getMethod("getRequestMatcher").invoke(chain));
            trace.pending=new Candidate(chainType,matcherType);
        }catch(Throwable ignored){trace.incomplete=true;}
    }
    public static void matched(boolean result){
        Trace trace=outer();if(trace==null)return;
        try{
            Candidate candidate=trace.pending;trace.pending=null;
            if(candidate==null){trace.incomplete=true;return;}
            Map<String,Object> entry=new LinkedHashMap<>();
            entry.put("index",trace.matches.size()+1);entry.put("chainType",candidate.chainType());
            entry.put("matcherType",candidate.matcherType());entry.put("matched",result);
            trace.matches.add(entry);
        }catch(Throwable ignored){trace.incomplete=true;}
    }
    public static void selected(Object filters){
        Trace trace=outer();if(trace==null)return;
        try{
            if(trace.selectionSeen){trace.incomplete=true;return;}
            trace.selectionSeen=true;
            if(filters==null)return;
            if(!(filters instanceof List<?> values)||!FILTER_LISTS.contains(filters.getClass().getName())){trace.incomplete=true;return;}
            int retained=Math.min(values.size(),MAX_FILTERS);
            if(values.size()>retained)trace.incomplete=true;
            for(int index=0;index<retained;index++)trace.configured.add(values.get(index));
        }catch(Throwable ignored){trace.incomplete=true;}
    }
    public static void entered(Object filter){
        Trace trace=outer();if(trace==null)return;
        try{
            String type=className(filter);
            if(OBSERVATION_FILTER.equals(type))return;
            if(type==null)trace.incomplete=true;
            int index=trace.entered.size();
            if(index>=trace.configured.size() || trace.configured.get(index)!=filter){trace.incomplete=true;return;}
            trace.entered.add(type);
        }catch(Throwable ignored){trace.incomplete=true;}
    }
    public static void decision(boolean granted){
        Trace trace=outer();if(trace==null)return;
        if(trace.decision!=null){trace.incomplete=true;return;}
        trace.decision=granted;
    }
    public static void end(Object request,Object response,boolean completed){
        Trace trace=current.get();if(trace==null||--trace.depth>0)return;
        current.remove();
        try{
            if(!enabled)return;
            boolean asynchronous=Boolean.TRUE.equals(servlet(request,"jakarta.servlet.ServletRequest","isAsyncStarted"));
            boolean complete=trace.selectionSeen&&!trace.incomplete&&trace.pending==null&&!asynchronous&&
                (trace.configured.isEmpty()||!trace.entered.isEmpty());
            Integer status=null;
            if(completed&&!asynchronous && servlet(response,"jakarta.servlet.http.HttpServletResponse","getStatus") instanceof Integer observed && observed>=100&&observed<=599)
                status=observed;
            Map<String,Object> report=new LinkedHashMap<>();
            report.put("id",trace.id);report.put("startedAt",trace.startedAt);report.put("durationMs",Math.min(3600000L,(System.nanoTime()-trace.started)/1000000));
            report.put("method",trace.method);report.put("status",status);report.put("completed",completed);
            report.put("coverage",complete?"observed":"partial");report.put("matches",trace.matches);
            report.put("selectedChain",trace.matches.stream().filter(item->Boolean.TRUE.equals(item.get("matched"))).map(item->item.get("index")).findFirst().orElse(null));
            report.put("configured",trace.configured.stream().map(SecurityTraceRuntime::className).toList());
            report.put("entered",trace.entered);report.put("authorizationDecision",trace.decision==null?"unobserved":trace.decision?"granted":"denied");
            if(trace.methods!=null){
                report.put("methodCoverage",methodCoverage(trace,asynchronous));
                report.put("methodDecisions",trace.methods.snapshot());
            }
            if(trace.authentication!=null){
                report.put("authenticationCoverage",trace.authentication.coverage(authenticationInstrumented(),asynchronous||trace.incomplete));
                report.put("authenticationManagers",trace.authentication.reports());
            }
            retain(report);
        }catch(Throwable ignored){}
    }
    private static synchronized String methodCoverage(Trace trace,boolean asynchronous){
        if(trace.methods==null)return "disabled";
        boolean before=hooks.contains("method-before"), after=hooks.contains("method-after");
        if(!before&&!after)return "unavailable";
        return before&&after&&!asynchronous&&!trace.incomplete&&!trace.methods.incomplete()?"observed":"partial";
    }
    static MethodSecurityTrace methodTrace(){
        if(!MethodSecurityTrace.enabled())return null;
        Trace trace=outer();return trace==null?null:trace.methods;
    }
    private static synchronized boolean authenticationInstrumented(){return hooks.contains(AuthenticationProviderTrace.HOOK);}
    static AuthenticationProviderTrace authenticationTrace(){
        if(!AuthenticationProviderTrace.enabled())return null;
        Trace trace=outer();return trace==null?null:trace.authentication;
    }
    private static Trace outer(){Trace trace=current.get();return trace!=null&&trace.depth==1?trace:null;}
    private static Object servlet(Object value,String api,String method)throws ReflectiveOperationException {
        if(value==null)return null;
        Class<?> type=Class.forName(api,false,value.getClass().getClassLoader());
        return type.isInstance(value)?type.getMethod(method).invoke(value):null;
    }
    private static String className(Object value){
        if(value==null)return null;
        String type=value.getClass().getName().split("/",2)[0];
        return type.length()<=192&&type.matches("[A-Za-z0-9_.$]+")?type:null;
    }
    private static synchronized void retain(Map<String,Object> report){
        if(!enabled)return;
        if(recent.size()==MAX_SAMPLES){recent.removeFirst();dropped++;}recent.addLast(report);
    }
    static synchronized Map<String,Object> snapshot(){
        Map<String,Object> report=new LinkedHashMap<>(Map.of("enabled",enabled,
            "state",!enabled?"disabled":hooks.contains("proxy")?"ready":"waiting",
            "hooks",List.copyOf(hooks),"dropped",dropped,"traces",List.copyOf(recent)));
        if(MethodSecurityTrace.enabled()){
            report.put("methodTraceEnabled",true);
            report.put("roleDisclosureEnabled",MethodSecurityTrace.roleDisclosureEnabled());
        }
        if(AuthenticationProviderTrace.enabled())report.put("authenticationProviderTraceEnabled",true);
        return report;
    }
}
