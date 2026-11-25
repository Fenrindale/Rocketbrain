package rocketbrain.observer;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Evidence from the original method-authorization and role-comparison call sites. */
public final class MethodSecurityTrace {
    private static final int MAX_EVENTS=8, MAX_NESTING=6, MAX_ROLES=12;
    private static final Object OMITTED=new Object();
    private static final String SPRING_INVOCATION="org.springframework.aop.framework.ReflectiveMethodInvocation";
    private static final String ROLE_HIERARCHY="org.springframework.security.access.hierarchicalroles.";
    private static final Pattern ROLE=Pattern.compile("[A-Za-z][A-Za-z0-9_:.\\-]{0,63}");
    private static final Pattern NAME=Pattern.compile("[A-Za-z0-9_.$\\[\\]]{1,192}");
    private static volatile boolean enabled;
    private static volatile Set<String> approvedRoles=Set.of();
    private final List<Frame> events=new ArrayList<>();
    private Frame current;
    private int suppressed;
    private boolean incomplete;

    private static final class Frame {
        final Frame parent;
        final String phase, manager, owner, method;
        final List<String> parameterTypes;
        final Set<String> sources=new LinkedHashSet<>(), checked=new LinkedHashSet<>(), matched=new LinkedHashSet<>();
        String decision="unobserved", decisionSource="incomplete", delegateManager;
        Object activeManager;
        boolean collecting=true;
        final int depth;

        Frame(Frame parent,String phase,Object invocation,Object manager){
            this.parent=parent;this.phase=phase;this.manager=type(manager);this.activeManager=manager;
            depth=parent==null?1:parent.depth+1;
            Method target=target(invocation);
            owner=target==null?null:name(target.getDeclaringClass().getName());
            method=target==null?null:name(target.getName());
            parameterTypes=signature(target);
        }

        Map<String,Object> report(){
            Map<String,Object> entry=new LinkedHashMap<>();
            entry.put("phase",phase);entry.put("manager",manager);entry.put("delegateManager",delegateManager);entry.put("owner",owner);
            entry.put("method",method);entry.put("parameterTypes",parameterTypes);
            entry.put("decision",decision);entry.put("decisionSource",decisionSource);
            entry.put("roleSources",List.copyOf(sources));entry.put("checkedRoles",List.copyOf(checked));
            entry.put("matchedRoles",List.copyOf(matched));
            return entry;
        }
    }

    static void configure(boolean capture,Object roleLabels){
        Set<String> labels=new LinkedHashSet<>();
        if(roleLabels!=null){
            if(!(roleLabels instanceof List<?> values)||values.size()>MAX_ROLES)throw new IllegalArgumentException("Invalid security trace roles");
            for(Object value:values)
                if(!(value instanceof String label)||!ROLE.matcher(label).matches()||!labels.add(label))
                    throw new IllegalArgumentException("Invalid security trace roles");
        }
        approvedRoles=capture?Set.copyOf(labels):Set.of();
        enabled=capture;
    }
    static boolean enabled(){return enabled;}
    static boolean roleDisclosureEnabled(){return !approvedRoles.isEmpty();}

    public static Object enter(String phase,Object invocation,Object manager){
        MethodSecurityTrace trace=SecurityTraceRuntime.methodTrace();
        if(trace==null)return null;
        try {
            if(trace.suppressed>0||trace.events.size()>=MAX_EVENTS||trace.current!=null&&trace.current.depth>=MAX_NESTING){
                trace.incomplete=true;trace.suppressed++;return OMITTED;
            }
            Frame frame=new Frame(trace.current,phase,invocation,manager);
            trace.events.add(frame);trace.current=frame;return frame;
        }catch(Throwable ignored){trace.incomplete=true;return null;}
    }

    public static void result(Object result,Object ticket){
        MethodSecurityTrace trace=SecurityTraceRuntime.methodTrace();
        if(trace==null||ticket==null||trace.current!=ticket)return;
        trace.current.collecting=false;trace.current.activeManager=null;
        if(result==null)trace.finish(trace.current,"abstained","no-result");
    }

    public static void decision(boolean granted,Object ticket){
        MethodSecurityTrace trace=SecurityTraceRuntime.methodTrace();
        if(trace==null||ticket==null||trace.current!=ticket)return;
        trace.finish(trace.current,granted?"granted":"denied","framework-result");
    }

    public static void thrownDenial(Object ticket){
        MethodSecurityTrace trace=SecurityTraceRuntime.methodTrace();
        if(trace==null||ticket==null||trace.current!=ticket)return;
        trace.finish(trace.current,"denied","manager-threw-denial");
    }

    public static void exit(Object ticket){
        MethodSecurityTrace trace=SecurityTraceRuntime.methodTrace();
        if(trace==null||ticket==null)return;
        if(ticket==OMITTED){if(trace.suppressed>0)trace.suppressed--;return;}
        if(trace.current==ticket){trace.incomplete=true;trace.finish(trace.current,"unobserved","incomplete");}
    }

    private void finish(Frame frame,String decision,String source){
        frame.collecting=false;frame.activeManager=null;frame.decision=decision;frame.decisionSource=source;current=frame.parent;
    }

    public static void managerDelegate(Object wrapper,Object delegate){
        Frame frame=collecting();
        if(frame==null||frame.activeManager!=wrapper)return;
        try {
            frame.activeManager=delegate;
            frame.delegateManager=type(delegate);
        }catch(Throwable ignored){}
    }

    public static void roleSource(Object hierarchy){
        Frame frame=collecting();
        if(frame==null)return;
        try {
            String source=type(hierarchy);
            if((ROLE_HIERARCHY+"RoleHierarchyImpl").equals(source))frame.sources.add("role-hierarchy");
            else if((ROLE_HIERARCHY+"NullRoleHierarchy").equals(source))frame.sources.add("direct-authorities");
            else frame.sources.add("custom-hierarchy");
        }catch(Throwable ignored){}
    }

    public static void roleCompared(boolean matched,Object candidate){
        Frame frame=collecting();
        if(frame==null)return;
        try {
            if(candidate instanceof String role&&approvedRoles.contains(role)){
                frame.checked.add(role);
                if(matched)frame.matched.add(role);
            }
        }catch(Throwable ignored){}
    }

    private static Frame collecting(){
        MethodSecurityTrace trace=SecurityTraceRuntime.methodTrace();
        return trace==null||trace.suppressed>0||trace.current==null||!trace.current.collecting?null:trace.current;
    }

    List<Map<String,Object>> snapshot(){return events.stream().map(Frame::report).toList();}
    boolean incomplete(){return incomplete||current!=null||suppressed>0;}

    private static Method target(Object invocation){
        if(invocation==null||!SPRING_INVOCATION.equals(invocation.getClass().getName()))return null;
        try {return invocation.getClass().getMethod("getMethod").invoke(invocation) instanceof Method value?value:null;}
        catch(Throwable ignored){return null;}
    }

    private static List<String> signature(Method method){
        if(method==null||method.getParameterCount()>8)return null;
        var names=new ArrayList<String>();
        for(Class<?> parameter:method.getParameterTypes()){
            String type=name(parameter.getTypeName());
            if(type==null)return null;
            names.add(type);
        }
        return List.copyOf(names);
    }
    private static String type(Object value){return value==null?null:name(value.getClass().getName());}
    private static String name(String value){return value.length()<=192&&NAME.matcher(value).matches()?value:null;}
}
