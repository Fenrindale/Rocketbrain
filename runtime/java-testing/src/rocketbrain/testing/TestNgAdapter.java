package rocketbrain.testing;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.testng.*;
import org.testng.annotations.*;
import org.testng.xml.*;

/** Public TestNG API adapter. Discovery describes compiled annotations; actual cases come from listeners. */
final class TestNgAdapter implements ITestListener, IConfigurationListener, IDataProviderInterceptor, IAnnotationTransformer, IMethodInterceptor {
    private static final String ENGINE="[engine:testng]";
    private final Map<String,Class<?>> classes=new LinkedHashMap<>();
    private final Map<String,Method> methods=new LinkedHashMap<>();
    private final Set<String> allowedMethods=new LinkedHashSet<>(),wholeMethods=new HashSet<>(),selectedInvocations=new LinkedHashSet<>(),excluded=new LinkedHashSet<>(),published=new HashSet<>(),seen=new HashSet<>();
    private final Map<String,Deque<String>> providerRows=new HashMap<>();
    private final Map<String,Integer> repetitions=new HashMap<>();
    private final Map<Object,Integer> instances=new IdentityHashMap<>();
    private final Set<String> factories=new LinkedHashSet<>(),ambiguousRows=new HashSet<>();
    private long started,succeeded,failed,skipped,configurationFailures;
    private int instanceCounter,unknownCounter;
    private static final String RESULT_ID="rocketbrain.invocation";
    private TestNgAdapter(){}
    static int execute(String mode) throws Exception {return new TestNgAdapter().perform(mode);}
    private int perform(String mode) throws Exception {
        for(int i=0;i<Runner.number("excludeCount");i++)excluded.add(Runner.value("exclude."+i));
        List<String> requestedClasses=new ArrayList<>(),packages=new ArrayList<>(),methodRequests=new ArrayList<>(),uids=new ArrayList<>();Set<String> wholeClasses=new HashSet<>();boolean allSelected=Runner.number("selectorCount")==0;
        for(int i=0;i<Runner.number("selectorCount");i++){
            String kind=Runner.value("selector."+i+".kind"),value=Runner.value("selector."+i+".value");
            switch(kind){case "class"->{requestedClasses.add(value);wholeClasses.add(value);}case "package"->packages.add(value);case "method"->{requestedClasses.add(value.split("#",2)[0]);methodRequests.add(value);}case "uniqueId"->{if(!value.matches("\\[engine:testng\\](?:/\\[class:[A-Za-z0-9_-]+\\](?:/\\[method:[A-Za-z0-9_-]+\\](?:/\\[invocation:(?:[a-f0-9]{64}|unresolved-[0-9]+):[0-9]+\\](?:/\\[factory:[0-9]+\\])?)?)?)?"))throw new IllegalArgumentException("Unsupported or malformed exact TestNG identity; select a current class/method/test ID.");if(value.equals(ENGINE))allSelected=true;else{uids.add(value);requestedClasses.add(decodePart(value,"class"));}}default->throw new IllegalArgumentException("Unsupported TestNG selector.");}
        }
        if(allSelected||!packages.isEmpty()){
            for(int i=0;i<Runner.number("rootCount");i++){
                Path root=Path.of(URI.create(Runner.value("root."+i)));
                try(var files=Files.walk(root)){for(Path file:files.filter(Files::isRegularFile).filter(p->p.toString().endsWith(".class")).limit(20001).toList()){
                    if(classes.size()>10000)throw new IllegalArgumentException("TestNG class scan limit.");
                    String name=root.relativize(file).toString().replace('\\','.').replace('/','.').replaceAll("\\.class$","");
                    if(name.equals("module-info")||name.endsWith("package-info")||!allSelected&&!packages.isEmpty()&&packages.stream().noneMatch(p->name.startsWith(p+".")))continue;
                    addClass(name,false);
                }}
            }
        }for(String name:new LinkedHashSet<>(requestedClasses))addClass(name,true);
        for(Class<?> type:classes.values()){if(hasFactory(type))factories.add(type.getName());for(Method method:allMethods(type))if(isTest(type,method))methods.put(methodId(type,method),method);}
        for(var entry:methods.entrySet()){
            String id=entry.getKey();Method method=entry.getValue();Class<?> owner=classes.get(decodePart(id,"class"));
            boolean whole=allSelected||wholeClasses.contains(owner.getName())||packages.stream().anyMatch(p->owner.getName().startsWith(p+"."));
            for(String selector:methodRequests){String[] parts=selector.split("#",2);if(owner.getName().equals(parts[0])&&parts.length==2&&(parts[1].equals(method.getName())||parts[1].equals(signature(method))))whole=true;}
            boolean accepted=whole;for(String uid:uids)if(id.equals(uid)||id.startsWith(uid+"/")){accepted=true;whole=true;}else if(uid.startsWith(id+"/"))accepted=true;
            if(!accepted||isExcluded(id))continue;
            allowedMethods.add(id);if(whole)wholeMethods.add(id);
        }
        for(String uid:uids)if(uid.contains("/[invocation:")){
            if(wholeMethods.stream().anyMatch(id->uid.startsWith(id+"/")))continue;
            if(uid.contains("unresolved")||uid.contains("/[factory:")||uid.contains("/[retry:"))throw new IllegalArgumentException("This TestNG factory/retry/object invocation cannot be selected reliably. Select its method or class.");
            selectedInvocations.add(uid);
        }
        for(String id:allowedMethods){Method selected=methods.get(id);String owner=decodePart(id,"class");List<Map.Entry<String,Method>> overloads=methods.entrySet().stream().filter(e->decodePart(e.getKey(),"class").equals(owner)&&e.getValue().getName().equals(selected.getName())).toList();if(overloads.size()>1&&overloads.stream().anyMatch(e->!allowedMethods.contains(e.getKey()))&&overloads.stream().anyMatch(e->{Test a=testAnnotation(classes.get(owner),e.getValue());return a.dependsOnMethods().length>0||a.dependsOnGroups().length>0;}))throw new IllegalArgumentException("TestNG dependency-bearing overloaded methods cannot be selected by exact public method identity; select the class or all overloads by name.");}
        for(String id:allowedMethods) {Method method=methods.get(id);Class<?> owner=classes.get(decodePart(id,"class"));if(selectedInvocations.stream().anyMatch(uid->uid.startsWith(id+"/"))&&(hasFactory(owner)||customRetry(owner,method)||testAnnotation(owner,method).invocationCount()!=1))throw new IllegalArgumentException("Individual factory/retry/invocationCount TestNG cases require method/class selection.");}
        publish(ENGINE,null,"TestNG 7.11.0","container",null,null,true,null);
        for(String factory:factories){Class<?> owner=classes.get(factory);publishClass(owner);for(Method method:allMethods(owner))if(method.isAnnotationPresent(Factory.class))publish(classId(owner)+"/[factory-template:"+encode(signature(method))+"]",classId(owner),method.getName()+" (factory)","container",owner,method,false,"Factory-created test cases and instance identity are unknown until actual execution. Select the factory class.");}
        for(String id:allowedMethods){Method method=methods.get(id);Class<?> owner=classes.get(decodePart(id,"class"));publishClass(owner);Test annotation=testAnnotation(owner,method);boolean template=!annotation.dataProvider().isEmpty()||annotation.invocationCount()!=1||hasFactory(owner);
            publish(id,classId(owner),method.getName(),"container",owner,method,true,null);
        }
        Runner.emit(Runner.map("type","plan","testsFound",allowedMethods.size(),"framework","testng","discoveryScope","Compiled TestNG annotations; provider/factory cases appear only during actual execution."));
        if(mode.equals("discover")){Runner.emit(Runner.map("type","complete","summary",Runner.map("testsFound",allowedMethods.size())));return 0;}
        if(allowedMethods.isEmpty()&&factories.isEmpty()&&Runner.number("selectorCount")>0)throw new IllegalArgumentException("No current TestNG method matched the selection.");
        XmlSuite suite=new XmlSuite();suite.setName("Rocketbrain TestNG");suite.setParallel(XmlSuite.ParallelMode.NONE);suite.setThreadCount(1);suite.setDataProviderThreadCount(1);
        XmlTest test=new XmlTest(suite);test.setName("Selected tests");test.setPreserveOrder(true);
        List<XmlClass> xmlClasses=new ArrayList<>();
        for(Class<?> owner:classes.values()){
            List<XmlInclude> includes=new ArrayList<>();Set<String> names=new LinkedHashSet<>();
            for(String id:allowedMethods)if(decodePart(id,"class").equals(owner.getName()))names.add(methods.get(id).getName());
            for(String name:names)includes.add(new XmlInclude(name));boolean selectedFactory=factories.contains(owner.getName())&&(allSelected||wholeClasses.contains(owner.getName())||packages.stream().anyMatch(p->owner.getName().startsWith(p+"."))||uids.contains(classId(owner)));if(!includes.isEmpty()||selectedFactory){XmlClass xml=new XmlClass(owner);xml.setIncludedMethods(includes);xmlClasses.add(xml);}
        }
        test.setXmlClasses(xmlClasses);
        TestNG engine=new TestNG(false);engine.setUseDefaultListeners(false);engine.setVerbose(-1);engine.setPreserveOrder(true);engine.setThreadCount(1);engine.setDataProviderThreadCount(1);engine.setXmlSuites(List.of(suite));engine.addListener(this);
        Runner.emit(Runner.map("type","started","test",descriptor(ENGINE,null,"TestNG 7.11.0","container",null,null,true,null)));
        long begin=System.currentTimeMillis();engine.run();
        for(String id:allowedMethods){Method method=methods.get(id);Class<?> owner=classes.get(decodePart(id,"class"));if(!testAnnotation(owner,method).enabled()){Map<String,Object> data=descriptor(id,classId(owner),method.getName(),"test",owner,method,true,null);Runner.emit(Runner.map("type","skipped","test",data,"reason","Disabled TestNG annotation"));skipped++;}}
        if(!seen.containsAll(selectedInvocations))throw new IllegalArgumentException("The selected TestNG data-provider case no longer matches the current safe parameter fingerprint.");
        PerTestCoverage.finishSuite();Runner.saveCoverage();
        Runner.emit(Runner.map("type","finished","test",descriptor(ENGINE,null,"TestNG 7.11.0","container",null,null,true,null),"state",configurationFailures>0?"failed":"passed"));
        Runner.emit(Runner.map("type","complete","summary",Runner.map("testsFound",started+skipped,"testsStarted",started,"testsSucceeded",succeeded,"testsFailed",failed,"testsSkipped",skipped,"testsAborted",0,"containersFailed",configurationFailures,"durationMs",System.currentTimeMillis()-begin),"framework","testng"));
        return failed>0||configurationFailures>0?1:0;
    }
    private void addClass(String name,boolean required) throws Exception {
        try{Class<?> type=Class.forName(name,false,Thread.currentThread().getContextClassLoader());if(!type.isInterface()&&!Modifier.isAbstract(type.getModifiers())&&(hasFactory(type)||allMethods(type).stream().anyMatch(m->isTest(type,m))))classes.put(type.getName(),type);}catch(LinkageError|ClassNotFoundException error){if(required)throw new IllegalArgumentException("TestNG class is unavailable: "+name,error);}
    }
    private static List<Method> allMethods(Class<?> type){Map<String,Method> result=new LinkedHashMap<>();for(Class<?> at=type;at!=null&&at!=Object.class;at=at.getSuperclass())for(Method method:at.getDeclaredMethods())if(!method.isSynthetic()&&!method.isBridge())result.putIfAbsent(signature(method),method);return new ArrayList<>(result.values());}
    private static boolean isTest(Class<?> owner,Method method){if(method.getAnnotation(Test.class)!=null)return true;if(owner.getAnnotation(Test.class)==null||!Modifier.isPublic(method.getModifiers())||Modifier.isStatic(method.getModifiers())||method.getDeclaringClass()==Object.class)return false;for(var annotation:method.getAnnotations())if(annotation.annotationType().getPackageName().equals("org.testng.annotations"))return false;return true;}
    private static Test testAnnotation(Class<?> owner,Method method){Test value=method.getAnnotation(Test.class);return value!=null?value:owner.getAnnotation(Test.class);}
    private static boolean hasFactory(Class<?> type){for(Method method:allMethods(type))if(method.isAnnotationPresent(Factory.class))return true;for(var constructor:type.getDeclaredConstructors())if(constructor.isAnnotationPresent(Factory.class))return true;return false;}
    private static boolean customRetry(Class<?> owner,Method method){Test value=testAnnotation(owner,method);return value!=null&&!value.retryAnalyzer().getName().endsWith("DisabledRetryAnalyzer");}
    private static String signature(Method method){return method.getName()+"("+String.join(",",Arrays.stream(method.getParameterTypes()).map(Class::getTypeName).toList())+")";}
    private static String encode(String value){return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));}
    private static String decodePart(String id,String part){String marker="/["+part+":";int start=id.indexOf(marker);if(start<0)throw new IllegalArgumentException("Invalid TestNG unique ID.");start+=marker.length();int end=id.indexOf(']',start);if(end<start)throw new IllegalArgumentException("Invalid TestNG unique ID.");return new String(Base64.getUrlDecoder().decode(id.substring(start,end)),StandardCharsets.UTF_8);}
    private static String classId(Class<?> type){return ENGINE+"/[class:"+encode(type.getName())+"]";}
    private static String methodId(Class<?> type,Method method){return classId(type)+"/[method:"+encode(signature(method))+"]";}
    private boolean isExcluded(String id){return excluded.stream().anyMatch(value->id.equals(value)||id.startsWith(value+"/"));}
    private void publishClass(Class<?> type){publish(classId(type),ENGINE,type.getSimpleName(),"container",type,null,true,null);}
    private void publish(String id,String parent,String label,String kind,Class<?> type,Method method,boolean rerunnable,String reason){if(published.add(id))Runner.emit(Runner.map("type","discovered","test",descriptor(id,parent,label,kind,type,method,rerunnable,reason)));}
    private static Map<String,Object> descriptor(String id,String parent,String label,String kind,Class<?> type,Method method,boolean rerunnable,String reason){Map<String,Object> result=Runner.map("id",id,"parentId",parent,"label",label,"kind",kind,"tags",List.of(),"framework","testng","rerunnable",rerunnable);if(type!=null)result.put("className",type.getName());if(method!=null){result.put("methodName",method.getName());result.put("methodParameterTypes",String.join(",",Arrays.stream(method.getParameterTypes()).map(Class::getTypeName).toList()));}if(reason!=null)result.put("selectionReason",reason);return result;}
    private static String safeKey(Object[] values){try{StringBuilder out=new StringBuilder();for(Object value:values){if(value==null)out.append("null;");else if(value instanceof String text)out.append("string:").append(text.length()).append(':').append(text).append(';');else if(value instanceof Float number)out.append("float-bits:").append(Integer.toHexString(Float.floatToRawIntBits(number))).append(';');else if(value instanceof Double number)out.append("double-bits:").append(Long.toHexString(Double.doubleToRawLongBits(number))).append(';');else if(value instanceof Boolean||value instanceof Character||value instanceof Byte||value instanceof Short||value instanceof Integer||value instanceof Long)out.append(value.getClass().getName()).append(':').append(value).append(';');else if(value instanceof Enum<?> constant)out.append(constant.getDeclaringClass().getName()).append(':').append(constant.name()).append(';');else return null;}MessageDigest digest=MessageDigest.getInstance("SHA-256");for(int index=0;index<out.length();index++){char unit=out.charAt(index);digest.update((byte)(unit>>>8));digest.update((byte)unit);}return HexFormat.of().formatHex(digest.digest());}catch(Exception ignored){return null;}}
    @Override public List<IMethodInstance> intercept(List<IMethodInstance> candidates,ITestContext context){return candidates.stream().filter(candidate->{ITestNGMethod m=candidate.getMethod();Method reflected=m.getConstructorOrMethod().getMethod();return allowedMethods.contains(methodId(m.getRealClass(),reflected))||!factories.isEmpty()&&!classes.containsKey(m.getRealClass().getName());}).toList();}
    @Override public synchronized Iterator<Object[]> intercept(Iterator<Object[]> original,IDataProviderMethod provider,ITestNGMethod method,ITestContext context){
        Method reflected=method.getConstructorOrMethod().getMethod();String base=methodId(method.getRealClass(),reflected);Map<String,Integer> duplicate=new HashMap<>();List<Object[]> selected=new ArrayList<>();int count=0;
        while(original.hasNext()){if(++count>10000)throw new IllegalArgumentException("TestNG data-provider row limit.");Object[] row=original.next();String fingerprint=safeKey(row),key=fingerprint==null?"unresolved-"+(++unknownCounter):fingerprint;int ordinal=duplicate.merge(key,1,Integer::sum)-1;String id=base+"/[invocation:"+key+":"+ordinal+"]";
            if(!selectedInvocations.isEmpty()&&selectedInvocations.stream().anyMatch(value->value.startsWith(base+"/"))&&!selectedInvocations.contains(id)||isExcluded(id))continue;
            providerRows.computeIfAbsent(base+":"+key,k->new ArrayDeque<>()).add(id);selected.add(row);
        }
        for(var entry:duplicate.entrySet())if(entry.getValue()>1){ambiguousRows.add(base+":"+entry.getKey());if(selectedInvocations.stream().anyMatch(id->id.startsWith(base+"/[invocation:"+entry.getKey()+":")))throw new IllegalArgumentException("Identical data-provider parameters have no stable public row identity; select the method.");}return selected.iterator();
    }
    private synchronized Map<String,Object> identify(ITestResult result){Object existing=result.getAttribute(RESULT_ID);if(existing instanceof Map<?,?>)return (Map<String,Object>)existing;Method method=result.getMethod().getConstructorOrMethod().getMethod();Class<?> owner=result.getTestClass().getRealClass();String base=methodId(owner,method);publishClass(owner);publish(base,classId(owner),method.getName(),"container",owner,method,true,null);String key=safeKey(result.getParameters());boolean factory=hasFactory(owner)||(result.getFactoryParameters()!=null&&result.getFactoryParameters().length>0)||!factories.isEmpty();boolean stable=key!=null&&!factory&&!ambiguousRows.contains(base+":"+key)&&result.getMethod().getInvocationCount()==1&&!customRetry(owner,method);String id;
        Deque<String> rows=key==null?null:providerRows.get(base+":"+key);if(rows!=null&&!rows.isEmpty())id=rows.removeFirst();else{id=base+"/[invocation:"+(key==null?"unresolved-"+(++unknownCounter):key)+":"+(repetitions.merge(base+":"+key,1,Integer::sum)-1)+"]";}
        if(factory)id+="/[factory:"+instances.computeIfAbsent(result.getInstance(),ignored->++instanceCounter)+"]";
        Map<String,Object> data=descriptor(id,base,method.getName()+" [case "+(started+1)+"]","test",owner,method,stable,stable?null:"Object parameters, factory instances, retries or invocationCount require method/class selection.");result.setAttribute(RESULT_ID,data);if(published.add(id))Runner.emit(Runner.map("type","dynamic","test",data));seen.add(id);return data;
    }
    @Override public void onTestStart(ITestResult result){Map<String,Object> data=identify(result);started++;result.setAttribute("rocketbrain.coverageStarted",true);PerTestCoverage.start((String)data.get("id"));Runner.emit(Runner.map("type","started","test",data));}
    @Override public void onTestSuccess(ITestResult result){succeeded++;finish(result,"passed");}
    @Override public void onTestFailure(ITestResult result){failed++;finish(result,"failed");}
    @Override public void onTestFailedButWithinSuccessPercentage(ITestResult result){failed++;finish(result,"failed");}
    @Override public void onTestSkipped(ITestResult result){skipped++;Map<String,Object> data=identify(result);Runner.emit(Runner.map("type","skipped","test",data,"reason",result.wasRetried()?"Retry attempt":"TestNG skipped/dependency/configuration"));if(Boolean.TRUE.equals(result.getAttribute("rocketbrain.coverageStarted")))PerTestCoverage.finish((String)data.get("id"));}
    private void finish(ITestResult result,String state){Map<String,Object> data=identify(result),event=Runner.map("type","finished","test",data,"state",state,"durationMs",Math.max(0,result.getEndMillis()-result.getStartMillis()));if(result.getThrowable()!=null)event.put("error",Runner.failure(result.getThrowable()));Runner.emit(event);PerTestCoverage.finish((String)data.get("id"));}
    @Override public void onConfigurationFailure(ITestResult result){configurationFailures++;Method method=result.getMethod().getConstructorOrMethod().getMethod();Class<?> owner=result.getTestClass().getRealClass();publishClass(owner);String id=classId(owner)+"/[configuration:"+encode(signature(method))+"]";Runner.emit(Runner.map("type","finished","test",descriptor(id,classId(owner),method.getName(),"container",owner,method,false,"Configuration failure"),"state","failed","error",Runner.failure(result.getThrowable())));}
    @Override public void transform(ITestAnnotation annotation,Class testClass,java.lang.reflect.Constructor constructor,Method method){if(PerTestCoverage.enabled())annotation.setThreadPoolSize(1);}
    @Override public void transform(IDataProviderAnnotation annotation,Method method){if(PerTestCoverage.enabled())annotation.setParallel(false);}
}
