<font face=XNSFengTangHaiYanWei>Cascading Style Sheets<br>元素说明手册<br></font>
---

1. `position` <font face=XNSFengTangHaiYanWei><font color="ee82ee">
   元素位置</font><br>
   该属性定义元素在页面上的位置，共有5种定位方法。  
   `static` 元素的位置遵循文档流; 也即无定位  
   `fixed` 元素的位置相对于浏览器窗口; 换言之不会随窗口滚动而移动  
   `relative` 元素的位置相对于其static位置  
   `absolute` 元素的位置相对于最近的已定位父元素; 如果没有则相对于html  
   `sticky` 元素的定位基于用户的滚动  

   1. `fixed`和`absolute`定位的元素不在文档流中，不占据任何空间  
   2. `relative`定位的元素无论如何位移，其在文档流所占空间并不会改变
   3. `sticky`定位的元素必须至少指定一个属性（`top`,`bottom`,`left`,`right`）以作为阈值，用于判断元素是否超出视图
   4. `sticky`元素的视图在超出其父元素视图前表现为relative, 其后表现为fixed

2. `z-index` <font face=XNSFengTangHaiYanWei><font color="ee82ee">
   z轴编号</font><br>
   该属性定义元素在页面的Z轴位置（坐标为**整形**，可为负）。  
   通俗来讲，图层顺序  

   1. 若未指定，则默认为0（`z-index: auto`）  
   2. 只能应用于position为`absolute`,`relative`,`fixed`以及`display: flex`的容器

3. `box-sizing` <font face=XNSFengTangHaiYanWei><font color="ee82ee">
   盒模型行为</font><br>
   控制浏览器如何映射`width`和`height`属性并计算元素的总宽度/高度，共有2种方式  
   `content-box` 将属性映射到内容上（`content`）  
   `border-box` 将属性映射到所有部分（`content`,`padding`,`border`）  
   `inherit` 从父元素中继承值  

   1. `border-box`为普遍实践的更优解，能显著减少宽度计算错误，在移动端开发中亦是如此

4. `inset` <font face=XNSFengTangHaiYanWei><font color="ee82ee">
   内插值</font><br>
   `top`,`right`,`bottom`和`left`属性的简写属性  
   <<font color="88ff88">多值语法</font>>