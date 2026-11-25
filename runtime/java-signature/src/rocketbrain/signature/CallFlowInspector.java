package rocketbrain.signature;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import rocketbrain.signature.SignatureInspector.Flow;
import rocketbrain.signature.SignatureInspector.Source;

import static rocketbrain.signature.SignatureInspector.flowMethod;
import static rocketbrain.signature.SignatureInspector.key;
import static rocketbrain.signature.SignatureInspector.object;

final class CallFlowInspector {
    private record Caller(TreePath method, String uri, int start, int end, String signature) {
        Map<String,Object> output() {
            return object("uri",uri,"start",start,"end",end,"method",signature);
        }
    }
    private record Incoming(List<Caller> callers, int omitted) {}

    private final Trees trees;
    private final SourcePositions positions;
    private final Map<String,Source> sources;
    private final List<Flow.Event> events = new ArrayList<>();
    private final Deque<ExecutableElement> stack = new ArrayDeque<>();
    private Caller selectedCaller;
    private int selectedFrame = 0;
    private int frames;

    CallFlowInspector(Trees trees, Map<String,Source> sources) {
        this.trees = trees;
        positions = trees.getSourcePositions();
        this.sources = sources;
    }

    private static UnsupportedOperationException refuse(String message) {
        return new UnsupportedOperationException(message);
    }

    private static String uri(TreePath route) {
        return route.getCompilationUnit().getSourceFile().toUri().toString();
    }

    private static boolean simpleResult(ExecutableElement method) {
        return method.getKind() == ElementKind.METHOD && !method.isVarArgs() && method.getTypeParameters().isEmpty() &&
            Flow.scalar(method.getReturnType()) && method.getParameters().stream().allMatch(param -> Flow.scalar(param.asType()));
    }

    private boolean direct(TreePath route, ExecutableElement caller, ExecutableElement target) {
        var select = ((MethodInvocationTree)route.getLeaf()).getMethodSelect();
        if (target.getModifiers().contains(Modifier.STATIC)) {
            return select instanceof IdentifierTree || select instanceof MemberSelectTree member &&
                trees.getElement(new TreePath(new TreePath(route,member),member.getExpression())) instanceof TypeElement;
        }
        if (!caller.getEnclosingElement().equals(target.getEnclosingElement())) return false;
        TypeElement type = (TypeElement)target.getEnclosingElement();
        if (!target.getModifiers().contains(Modifier.PRIVATE) && !target.getModifiers().contains(Modifier.FINAL) &&
            !type.getModifiers().contains(Modifier.FINAL)) return false;
        return select instanceof IdentifierTree || select instanceof MemberSelectTree member &&
            member.getExpression() instanceof IdentifierTree receiver && receiver.getName().contentEquals("this");
    }

    private int execute(TreePath route, ExecutableElement method, List<Integer> args, int frame) {
        if (stack.contains(method)) throw refuse("Recursive calls are outside the bounded Java call flow.");
        if (stack.size() >= 5 || frame > 48) throw refuse("Java call flow exceeds its call depth or frame limit.");
        stack.addLast(method);
        try {
            Flow flow = new Flow(route.getCompilationUnit(),trees,sources.get(uri(route)).text,events,key(method),frame,this::invoke);
            return flow.trace(route,args);
        } finally {
            stack.removeLast();
        }
    }

    private List<Integer> invoke(Flow caller, TreePath route, MethodInvocationTree call) {
        if (!(trees.getElement(route) instanceof ExecutableElement target) || !simpleResult(target) ||
            !direct(route,stack.getLast(),target)) {
            throw refuse("Trace a direct Java call with known dispatch and primitive or String parameters and return value.");
        }
        TreePath body = trees.getPath(target);
        if (body == null || !sources.containsKey(uri(body)) || !(body.getLeaf() instanceof MethodTree method) || method.getBody() == null) {
            throw refuse("The direct call needs a body in the selected Java project's saved source.");
        }
        if (stack.contains(target)) throw refuse("Recursive calls are outside the bounded Java call flow.");
        List<Integer> arguments = new ArrayList<>();
        for (int index = 0; index < call.getArguments().size(); index++) {
            var actual = call.getArguments().get(index);
            List<Integer> inputs = caller.expression(new TreePath(route,actual));
            arguments.add(caller.add("argument","Argument " + (index + 1),caller.start(actual),caller.end(actual),inputs));
        }
        int frame = frames++;
        if (caller.frame == 0 && selectedCaller != null && selectedCaller.uri().equals(uri(route)) &&
            selectedCaller.start() == caller.start(call.getMethodSelect())) selectedFrame = frame;
        int returned = execute(body,target,arguments,frame);
        if (returned < 0) throw refuse("The direct call has no modeled Java value return.");
        var select = call.getMethodSelect();
        return List.of(caller.add("call-result",key(target),caller.start(select),caller.end(select),List.of(returned)));
    }

    private Incoming incoming(List<CompilationUnitTree> units, ExecutableElement target) {
        List<Caller> callers = new ArrayList<>();
        int[] omitted = {0};
        if (!simpleResult(target)) return new Incoming(callers,0);
        for (CompilationUnitTree unit : units) {
            new TreePathScanner<Void,TreePath>() {
                @Override public Void visitLambdaExpression(LambdaExpressionTree lambda, TreePath method) {
                    return null;
                }
                @Override public Void visitMethod(MethodTree method, TreePath ignored) {
                    return super.visitMethod(method,getCurrentPath());
                }
                @Override public Void visitMethodInvocation(MethodInvocationTree call, TreePath method) {
                    TreePath route = getCurrentPath();
                    if (target.equals(trees.getElement(route))) {
                        long start = positions.getStartPosition(unit,call.getMethodSelect());
                        long end = positions.getEndPosition(unit,call.getMethodSelect());
                        if (method != null && trees.getElement(method) instanceof ExecutableElement owner &&
                            owner.getKind() == ElementKind.METHOD && !owner.equals(target) &&
                            owner.getParameters().stream().allMatch(param -> Flow.scalar(param.asType())) &&
                            ((MethodTree)method.getLeaf()).getBody() != null && direct(route,owner,target) &&
                            start >= 0 && end > start && callers.size() < 32) {
                            callers.add(new Caller(method,uri(route),(int)start,(int)end,key(owner)));
                        } else {
                            omitted[0]++;
                        }
                    }
                    return super.visitMethodInvocation(call,method);
                }
            }.scan(unit,null);
        }
        return new Incoming(callers,omitted[0]);
    }

    Map<String,Object> inspect(List<CompilationUnitTree> units, CompilationUnitTree unit, int offset, String callerUri, int callerOffset) {
        try {
            TreePath selected = flowMethod(unit,trees,offset);
            if (selected == null || !(trees.getElement(selected) instanceof ExecutableElement target) || target.getKind() != ElementKind.METHOD) {
                throw refuse("Place the cursor in a saved Java method.");
            }
            Incoming incoming = incoming(units,target);
            TreePath root = selected;
            if (!callerUri.isEmpty()) {
                selectedCaller = incoming.callers().stream().filter(item -> item.uri().equals(callerUri) && item.start() == callerOffset)
                    .findFirst().orElseThrow(() -> refuse("The selected direct caller changed. Trace the Java value again."));
                selectedFrame = -1;
                root = selectedCaller.method();
            }
            if (!(trees.getElement(root) instanceof ExecutableElement entry)) throw refuse("No modeled Java method was found.");
            execute(root,entry,List.of(),frames++);
            if (selectedFrame < 0) throw refuse("The selected caller is outside the supported straight-line Java flow.");
            return object("uri",uri(selected),"originFrame",selectedFrame,"method",key(target),
                "contexts",incoming.callers().stream().map(Caller::output).toList(),"omittedContexts",incoming.omitted(),
                "events",events.stream().map(event -> event.output(true)).toList());
        } catch (UnsupportedOperationException outside) {
            return object("error",outside.getMessage());
        }
    }
}
