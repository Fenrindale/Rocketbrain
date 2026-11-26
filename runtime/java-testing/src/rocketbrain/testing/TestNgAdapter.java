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
import org.testng.internal.TestResult;
import org.testng.internal.annotations.DisabledRetryAnalyzer;
import org.testng.xml.*;

/** TestNG adapter. Discovery describes compiled annotations; actual cases come from listeners. */
final class TestNgAdapter implements ITestListener, IConfigurationListener, IDataProviderInterceptor, IAnnotationTransformer, IMethodInterceptor {
    private static final String ENGINE="[engine:testng]";
    private static final String TEST_ID = "\\[engine:testng\\](?:/\\[class:[A-Za-z0-9_-]+\\](?:/\\[method:[A-Za-z0-9_-]+\\](?:/\\[invocation:(?:[a-f0-9]{64}|unresolved-[0-9]+):[0-9]+\\](?:/\\[(?:factory:[0-9]+|rows:[a-f0-9]{64}:[0-9]+)\\])?)?)?)?";
    private final NamedModuleTests named;
    private final Map<String,Class<?>> classes=new LinkedHashMap<>();
    private final Map<String,Method> methods=new LinkedHashMap<>();
    private final Set<String> allowedMethods=new LinkedHashSet<>(),wholeMethods=new HashSet<>(),selectedInvocations=new LinkedHashSet<>(),excluded=new LinkedHashSet<>(),published=new HashSet<>(),seen=new HashSet<>();
    private final Map<String,List<SubmittedRow>> providerRows=new HashMap<>();
    private final Map<String,Integer> attempts=new HashMap<>();
    private final Map<Object,Integer> instances=new IdentityHashMap<>();
    private final Set<String> factories=new LinkedHashSet<>();
    private long started,succeeded,failed,skipped,skippedWithoutStart,configurationFailures,testAttempts,retriesScheduled;
    private volatile String selectionError;
    private int instanceCounter,unknownCounter;
    private static final String RESULT_ID="rocketbrain.invocation";
    private static final String RESULT_ATTEMPT="rocketbrain.attempt";
    private record ProviderRow(Object[] values,String fingerprint,int index,int occurrence) {}
    private record SubmittedRow(String fingerprint,int index,int occurrence,String id) {}
    private TestNgAdapter(NamedModuleTests named) { this.named = named; }
    static int execute(String mode, NamedModuleTests named) throws Exception {return new TestNgAdapter(named).perform(mode);}
    private int perform(String mode) throws Exception {
        for(int i=0;i<Runner.number("excludeCount");i++){
            String id=Runner.value("exclude."+i);
            if(named!=null){
                checkId(id);
                if(!id.equals(ENGINE))named.requireClass(decodePart(id,"class"));
            }
            excluded.add(id);
        }
        List<String> requestedClasses=new ArrayList<>(),packages=new ArrayList<>(),methodRequests=new ArrayList<>(),uids=new ArrayList<>();Set<String> wholeClasses=new HashSet<>();boolean allSelected=Runner.number("selectorCount")==0;
        for(int i=0;i<Runner.number("selectorCount");i++){
            String kind=Runner.value("selector."+i+".kind"),value=Runner.value("selector."+i+".value");
            switch(kind){
                case "class" -> {requestedClasses.add(value);wholeClasses.add(value);}
                case "package" -> {
                    if(named!=null&&!named.containsPackage(value))throw new IllegalArgumentException("The selected package is outside the named test module.");
                    packages.add(value);
                }
                case "method" -> {requestedClasses.add(value.split("#",2)[0]);methodRequests.add(value);}
                case "uniqueId" -> {
                    checkId(value);
                    if(value.equals(ENGINE))allSelected=true;
                    else{uids.add(value);requestedClasses.add(decodePart(value,"class"));}
                }
                default -> throw new IllegalArgumentException("Unsupported TestNG selector.");
            }
        }
        if(allSelected||!packages.isEmpty()){
            for(int i=0;i<Runner.number("rootCount");i++){
                Path root=named==null?Path.of(URI.create(Runner.value("root."+i))):named.output();
                try(var files=Files.walk(root)){for(Path file:files.filter(Files::isRegularFile).filter(p->p.toString().endsWith(".class")).limit(20001).toList()){
                    if(classes.size()>10000)throw new IllegalArgumentException("TestNG class scan limit.");
                    String name=root.relativize(file).toString().replace('\\','.').replace('/','.').replaceAll("\\.class$","");
                    if(name.equals("module-info")||name.endsWith("package-info")||!allSelected&&!packages.isEmpty()&&packages.stream().noneMatch(p->name.startsWith(p+".")))continue;
                    addClass(name,false);
                }}
            }
        }for(String name:new LinkedHashSet<>(requestedClasses))addClass(name,true);
        for(Class<?> type:classes.values()){
            if(hasFactory(type)){
                if(named!=null)throw new IllegalArgumentException("Named TestNG profiles currently require directly declared test classes instead of @Factory.");
                factories.add(type.getName());
            }
            for(Method method:allMethods(type))if(isTest(type,method)){
                if(named!=null){
                    named.requireTestNgAccess(method.getDeclaringClass());
                    Class<?> provider=testAnnotation(type,method).dataProviderClass();
                    if(provider!=null&&provider!=Object.class)named.requireTestNgAccess(provider);
                }
                methods.put(methodId(type,method),method);
            }
        }
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
            if(uid.contains("unresolved")||uid.contains("/[factory:"))throw new IllegalArgumentException("This TestNG factory or unresolved invocation cannot be selected reliably. Select its method or class.");
            selectedInvocations.add(uid);
        }
        for(String id:allowedMethods){Method selected=methods.get(id);String owner=decodePart(id,"class");List<Map.Entry<String,Method>> overloads=methods.entrySet().stream().filter(e->decodePart(e.getKey(),"class").equals(owner)&&e.getValue().getName().equals(selected.getName())).toList();if(overloads.size()>1&&overloads.stream().anyMatch(e->!allowedMethods.contains(e.getKey()))&&overloads.stream().anyMatch(e->{Test a=testAnnotation(classes.get(owner),e.getValue());return a.dependsOnMethods().length>0||a.dependsOnGroups().length>0;}))throw new IllegalArgumentException("TestNG dependency-bearing overloaded methods cannot be selected by exact public method identity; select the class or all overloads by name.");}
        for(String id:allowedMethods) validateInvocationSelection(id);
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
        TestNG engine=new TestNG(false);engine.setUseDefaultListeners(false);engine.setVerbose(-1);engine.setPreserveOrder(true);engine.setThreadCount(1);engine.setDataProviderThreadCount(1);engine.setXmlSuites(List.of(suite));
        // Observe the effective provider stream after any project interceptors, retaining their relative order.
        engine.setListenerComparator((left,right)->Boolean.compare(left==this,right==this));
        engine.addListener(this);
        Runner.emit(Runner.map("type","started","test",descriptor(ENGINE,null,"TestNG 7.11.0","container",null,null,true,null)));
        long begin=System.currentTimeMillis();engine.run();
        if(selectionError!=null)throw new IllegalArgumentException(selectionError);
        for(String id:allowedMethods){Method method=methods.get(id);Class<?> owner=classes.get(decodePart(id,"class"));if(!testAnnotation(owner,method).enabled()){Map<String,Object> data=descriptor(id,classId(owner),method.getName(),"test",owner,method,true,null);Runner.emit(Runner.map("type","skipped","test",data,"reason","Disabled TestNG annotation"));skipped++;skippedWithoutStart++;}}
        if(!seen.containsAll(selectedInvocations))throw new IllegalArgumentException("The selected TestNG invocation no longer matches the current safe parameters, provider schedule or retry policy.");
        PerTestCoverage.finishSuite();Runner.saveCoverage();
        Runner.emit(Runner.map("type","finished","test",descriptor(ENGINE,null,"TestNG 7.11.0","container",null,null,true,null),"state",configurationFailures>0?"failed":"passed"));
        Runner.emit(Runner.map("type","complete","summary",Runner.map("testsFound",started+skippedWithoutStart,"testsStarted",started,"testsSucceeded",succeeded,"testsFailed",failed,"testsSkipped",skipped,"testsAborted",0,"testAttempts",testAttempts,"retriesScheduled",retriesScheduled,"containersFailed",configurationFailures,"durationMs",System.currentTimeMillis()-begin),"framework","testng"));
        return failed>0||configurationFailures>0?1:0;
    }
    private void addClass(String name,boolean required) throws Exception {
        try{
            Class<?> type=named==null?Class.forName(name,false,Thread.currentThread().getContextClassLoader()):named.requireClass(name);
            if(!type.isInterface()&&!Modifier.isAbstract(type.getModifiers())&&(hasFactory(type)||allMethods(type).stream().anyMatch(m->isTest(type,m)))){
                if(named!=null)named.requireTestNgAccess(type);
                classes.put(type.getName(),type);
            }
        }catch(LinkageError|ClassNotFoundException error){if(required||named!=null)throw new IllegalArgumentException("TestNG class is unavailable: "+name,error);}
    }
    private static void checkId(String id) {
        if(!id.matches(TEST_ID))throw new IllegalArgumentException("Unsupported or malformed exact TestNG identity; select a current class/method/test ID.");
    }
    private static List<Method> allMethods(Class<?> type){Map<String,Method> result=new LinkedHashMap<>();for(Class<?> at=type;at!=null&&at!=Object.class;at=at.getSuperclass())for(Method method:at.getDeclaredMethods())if(!method.isSynthetic()&&!method.isBridge())result.putIfAbsent(signature(method),method);return new ArrayList<>(result.values());}
    private static boolean isTest(Class<?> owner,Method method){if(method.getAnnotation(Test.class)!=null)return true;if(owner.getAnnotation(Test.class)==null||!Modifier.isPublic(method.getModifiers())||Modifier.isStatic(method.getModifiers())||method.getDeclaringClass()==Object.class)return false;for(var annotation:method.getAnnotations())if(annotation.annotationType().getPackageName().equals("org.testng.annotations"))return false;return true;}
    private static Test testAnnotation(Class<?> owner,Method method){Test value=method.getAnnotation(Test.class);return value!=null?value:owner.getAnnotation(Test.class);}
    private static boolean hasFactory(Class<?> type){for(Method method:allMethods(type))if(method.isAnnotationPresent(Factory.class))return true;for(var constructor:type.getDeclaredConstructors())if(constructor.isAnnotationPresent(Factory.class))return true;return false;}
    private static boolean customRetry(ITestNGMethod method){Class<? extends IRetryAnalyzer> type=method.getRetryAnalyzerClass();return type!=null&&type!=DisabledRetryAnalyzer.class;}
    private static String signature(Method method){return method.getName()+"("+String.join(",",Arrays.stream(method.getParameterTypes()).map(Class::getTypeName).toList())+")";}
    private static String encode(String value){return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));}
    private static String decodePart(String id,String part){String marker="/["+part+":";int start=id.indexOf(marker);if(start<0)throw new IllegalArgumentException("Invalid TestNG unique ID.");start+=marker.length();int end=id.indexOf(']',start);if(end<start)throw new IllegalArgumentException("Invalid TestNG unique ID.");return new String(Base64.getUrlDecoder().decode(id.substring(start,end)),StandardCharsets.UTF_8);}
    private static String classId(Class<?> type){return ENGINE+"/[class:"+encode(type.getName())+"]";}
    private static String methodId(Class<?> type,Method method){return classId(type)+"/[method:"+encode(signature(method))+"]";}
    private static String invocationId(String method,String key,int occurrence){return method+"/[invocation:"+key+":"+occurrence+"]";}
    private boolean isExcluded(String id){return excluded.stream().anyMatch(value->id.equals(value)||id.startsWith(value+"/"));}
    private List<String> selectedRows(String method){return selectedInvocations.stream().filter(id->id.startsWith(method+"/")).toList();}
    private IllegalArgumentException selectionFailure(String reason){selectionError=reason;return new IllegalArgumentException(reason);}
    private void validateInvocationSelection(String id){
        List<String> selection=selectedRows(id);
        if(selection.isEmpty())return;
        Method method=methods.get(id);
        Class<?> owner=classes.get(decodePart(id,"class"));
        Test test=testAnnotation(owner,method);
        if(hasFactory(owner)||test.invocationCount()!=1)throw new IllegalArgumentException("Individual factory and invocationCount TestNG cases require method/class selection.");
        if(test.dataProvider().isEmpty()&&(method.getParameterCount()!=0||!selection.equals(List.of(invocationId(id,safeKey(new Object[0]),0))))){
            throw new IllegalArgumentException("The selected invocation does not identify the current no-argument TestNG method.");
        }
    }
    private void publishClass(Class<?> type){publish(classId(type),ENGINE,type.getSimpleName(),"container",type,null,true,null);}
    private void publish(String id,String parent,String label,String kind,Class<?> type,Method method,boolean rerunnable,String reason){if(published.add(id))Runner.emit(Runner.map("type","discovered","test",descriptor(id,parent,label,kind,type,method,rerunnable,reason)));}
    private static Map<String,Object> descriptor(String id,String parent,String label,String kind,Class<?> type,Method method,boolean rerunnable,String reason){Map<String,Object> result=Runner.map("id",id,"parentId",parent,"label",label,"kind",kind,"tags",List.of(),"framework","testng","rerunnable",rerunnable);if(type!=null)result.put("className",type.getName());if(method!=null){result.put("methodName",method.getName());result.put("methodParameterTypes",String.join(",",Arrays.stream(method.getParameterTypes()).map(Class::getTypeName).toList()));}if(reason!=null)result.put("selectionReason",reason);return result;}
    private static String safeKey(Object[] values){try{StringBuilder out=new StringBuilder();for(Object value:values){if(value==null)out.append("null;");else if(value instanceof String text)out.append("string:").append(text.length()).append(':').append(text).append(';');else if(value instanceof Float number)out.append("float-bits:").append(Integer.toHexString(Float.floatToRawIntBits(number))).append(';');else if(value instanceof Double number)out.append("double-bits:").append(Long.toHexString(Double.doubleToRawLongBits(number))).append(';');else if(value instanceof Boolean||value instanceof Character||value instanceof Byte||value instanceof Short||value instanceof Integer||value instanceof Long)out.append(value.getClass().getName()).append(':').append(value).append(';');else if(value instanceof Enum<?> constant)out.append(constant.getDeclaringClass().getName()).append(':').append(constant.name()).append(';');else return null;}MessageDigest digest=MessageDigest.getInstance("SHA-256");for(int index=0;index<out.length();index++){char unit=out.charAt(index);digest.update((byte)(unit>>>8));digest.update((byte)unit);}return HexFormat.of().formatHex(digest.digest());}catch(Exception ignored){return null;}}
    @Override public List<IMethodInstance> intercept(List<IMethodInstance> candidates,ITestContext context){return candidates.stream().filter(candidate->{ITestNGMethod m=candidate.getMethod();Method reflected=m.getConstructorOrMethod().getMethod();return allowedMethods.contains(methodId(m.getRealClass(),reflected))||!factories.isEmpty()&&!classes.containsKey(m.getRealClass().getName());}).toList();}
    @Override public synchronized Iterator<Object[]> intercept(Iterator<Object[]> original,IDataProviderMethod provider,ITestNGMethod method,ITestContext context){
        String base=methodId(method.getRealClass(),method.getConstructorOrMethod().getMethod());
        List<String> selected=selectedRows(base);
        List<String> excludedDuplicates=excluded.stream().filter(id->id.startsWith(base+"/")&&id.contains("/[rows:")).toList();
        List<ProviderRow> rows=new ArrayList<>();
        Map<String,Integer> occurrences=new HashMap<>();
        List<String> schedule=new ArrayList<>();
        boolean fullyScalar=true;
        while(original.hasNext()){
            if(rows.size()>=10000)throw new IllegalArgumentException("TestNG data-provider row limit.");
            Object[] values=original.next();
            String fingerprint=values==null?null:safeKey(values);
            fullyScalar&=values==null||fingerprint!=null;
            int occurrence=fingerprint==null?0:occurrences.merge(fingerprint,1,Integer::sum)-1;
            schedule.add(values==null?"filtered":fingerprint==null?"unresolved":fingerprint);
            rows.add(new ProviderRow(values==null?null:values.clone(),fingerprint,rows.size(),occurrence));
        }
        String scheduleKey=fullyScalar?safeKey(schedule.toArray()):null;
        boolean canReplay=method.getInvocationCount()==1&&method.getFactoryMethodParamsInfo()==null&&!hasFactory(method.getRealClass())&&
            (!customRetry(method)||provider.cacheDataForTestRetries());
        List<SubmittedRow> delivered=new ArrayList<>();
        List<Object[]> valuesToRun=new ArrayList<>();
        Set<String> matched=new HashSet<>(),matchedExclusions=new HashSet<>();
        for(ProviderRow row:rows){
            String fingerprint=row.fingerprint();
            boolean duplicate=fingerprint!=null&&occurrences.get(fingerprint)>1;
            boolean selectable=fingerprint!=null&&canReplay&&(!duplicate||scheduleKey!=null);
            String id=selectable?invocationId(base,fingerprint,row.occurrence()):null;
            if(id!=null&&duplicate)id+="/[rows:"+scheduleKey+":"+row.index()+"]";
            if(id!=null&&excluded.contains(id)){matchedExclusions.add(id);continue;}
            if(!selected.isEmpty()&&(id==null||!selected.contains(id)))continue;
            if(id!=null)matched.add(id);
            delivered.add(new SubmittedRow(fingerprint,row.index(),row.occurrence(),id));
            valuesToRun.add(row.values());
        }
        if(!matched.containsAll(selected))throw selectionFailure("The selected TestNG case cannot be replayed against the current safe provider schedule and retry policy.");
        if(!matchedExclusions.containsAll(excludedDuplicates))throw selectionFailure("The excluded TestNG case no longer matches its current provider schedule.");
        providerRows.put(base,delivered);
        return valuesToRun.iterator();
    }

    private SubmittedRow observedRow(String base,ITestResult result,String fingerprint){
        List<SubmittedRow> rows=providerRows.get(base);
        if(rows==null||fingerprint==null||!(result instanceof TestResult concrete))return null;
        // Pinned TestNG 7.11 propagates the effective iterator index through serial, parallel and retry callbacks.
        int index=concrete.getParameterIndex();
        if(index<0||index>=rows.size())return null;
        SubmittedRow row=rows.get(index);
        return row.id()!=null&&fingerprint.equals(row.fingerprint())?row:null;
    }

    @SuppressWarnings("unchecked")
    private Map<String,Object> identify(ITestResult result){
        Object existing=result.getAttribute(RESULT_ID);
        if(existing instanceof Map<?,?>)return (Map<String,Object>)existing;
        ITestNGMethod runtimeMethod=result.getMethod();
        Method method=runtimeMethod.getConstructorOrMethod().getMethod();
        Class<?> owner=result.getTestClass().getRealClass();
        String base=methodId(owner,method);
        publishClass(owner);
        publish(base,classId(owner),method.getName(),"container",owner,method,true,null);
        String key=safeKey(result.getParameters());
        boolean factory=hasFactory(owner)||runtimeMethod.getFactoryMethodParamsInfo()!=null||
            result.getFactoryParameters()!=null&&result.getFactoryParameters().length>0||!classes.containsKey(owner.getName());
        boolean actualStart=result.getStatus()==ITestResult.STARTED&&result.getThrowable()==null;
        SubmittedRow row=actualStart&&!factory?observedRow(base,result,key):null;
        boolean simple=actualStart&&!factory&&method.getParameterCount()==0&&key!=null&&runtimeMethod.getInvocationCount()==1&&
            runtimeMethod.getDataProviderMethod()==null&&!providerRows.containsKey(base)&&testAnnotation(owner,method).dataProvider().isEmpty();
        boolean stable=row!=null||simple;
        String id;
        if(row!=null)id=row.id();
        else if(simple)id=invocationId(base,key,0);
        else id=invocationId(base,"unresolved-"+(++unknownCounter),0);
        if(factory)id+="/[factory:"+instances.computeIfAbsent(result.getInstance(),ignored->++instanceCounter)+"]";
        String label=method.getName()+(row==null?" [case "+(started+1)+"]":" [row "+(row.index()+1)+"]");
        Map<String,Object> data=descriptor(id,base,label,"test",owner,method,stable,stable?null:
            "Exact TestNG selection needs safe parameters and an observed row or no-argument invocation; factory instances and invocationCount are unsupported.");
        if(row!=null){data.put("providerIndex",row.index());data.put("providerOccurrence",row.occurrence());}
        result.setAttribute(RESULT_ID,data);
        if(published.add(id))Runner.emit(Runner.map("type","dynamic","test",data));
        if(stable)seen.add(id);
        return data;
    }

    @Override public synchronized void onTestStart(ITestResult result){
        if(result.getAttribute(RESULT_ATTEMPT)!=null)return;
        Map<String,Object> data=identify(result);
        String id=(String)data.get("id");
        int attempt=attempts.merge(id,1,Integer::sum);
        if(attempt==1)started++;
        testAttempts++;
        result.setAttribute(RESULT_ATTEMPT,attempt);
        PerTestCoverage.start(id);
        Runner.emit(Runner.map("type","started","test",data,"attempt",attempt));
    }
    @Override public synchronized void onTestSuccess(ITestResult result){succeeded++;finish(result,"passed");}
    @Override public synchronized void onTestFailure(ITestResult result){failed++;finish(result,"failed");}
    @Override public synchronized void onTestFailedButWithinSuccessPercentage(ITestResult result){failed++;finish(result,"failed");}
    @Override public synchronized void onTestSkipped(ITestResult result){
        Map<String,Object> data=identify(result);
        Object attempt=result.getAttribute(RESULT_ATTEMPT);
        if(result.wasRetried()&&attempt!=null&&Boolean.TRUE.equals(data.get("rerunnable"))){
            retriesScheduled++;
            Runner.emit(Runner.map("type","retry","test",data,"attempt",attempt));
        }else{
            skipped++;
            if(attempt==null)skippedWithoutStart++;
            Runner.emit(Runner.map("type","skipped","test",data,"reason",result.wasRetried()?"Retry attempt with unresolved invocation identity":"TestNG skipped/dependency/configuration"));
        }
        if(attempt!=null)PerTestCoverage.finish((String)data.get("id"));
    }
    private void finish(ITestResult result,String state){
        Map<String,Object> data=identify(result);
        Object attempt=result.getAttribute(RESULT_ATTEMPT);
        Map<String,Object> event=Runner.map("type","finished","test",data,"state",state,"attempt",attempt,"durationMs",Math.max(0,result.getEndMillis()-result.getStartMillis()));
        if(result.getThrowable()!=null)event.put("error",Runner.failure(result.getThrowable()));
        Runner.emit(event);
        if(attempt!=null)PerTestCoverage.finish((String)data.get("id"));
    }
    @Override public synchronized void onConfigurationFailure(ITestResult result){configurationFailures++;Method method=result.getMethod().getConstructorOrMethod().getMethod();Class<?> owner=result.getTestClass().getRealClass();publishClass(owner);String id=classId(owner)+"/[configuration:"+encode(signature(method))+"]";Runner.emit(Runner.map("type","finished","test",descriptor(id,classId(owner),method.getName(),"container",owner,method,false,"Configuration failure"),"state","failed","error",Runner.failure(result.getThrowable())));}
    @Override public void transform(ITestAnnotation annotation,Class testClass,java.lang.reflect.Constructor constructor,Method method){if(PerTestCoverage.enabled())annotation.setThreadPoolSize(1);}
    @Override public void transform(IDataProviderAnnotation annotation,Method method){if(PerTestCoverage.enabled())annotation.setParallel(false);}
}
